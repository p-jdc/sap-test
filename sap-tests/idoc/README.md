# IDocs: model, mock receiver and sender

Everything for testing IDocs without a partner system:

- **The IDoc model:** one model for IDocs, used by the tests, the sample data, the receiver and later the app. It doesn't depend on how an IDoc travels.
- **The IDoc receiver:** plays the partner system SAP sends IDocs to, and keeps what it got.
- **The `idocInbox` fixture:** lets a test wait for the IDoc a business step produced.
- **The IDoc sender:** sends IDocs into SAP over HTTPS the way SAP Cloud Integration (CPI) does. It runs in the receiver, which holds the SAP system and its login, like CPI.
- **The `idocSender` fixture:** lets a test send an IDoc into SAP and get the IDoc number SAP gave it.

In the test app, the **Mock IDoc** page starts the receiver, shows what it got and sets its answers. It also sends sample IDocs into SAP and lists what was sent. Tests started from the app reach that receiver through `idocInbox` and `idocSender`.

Still to come: tRFC with SNC, for the connections that don't go through CPI.

## Try it

From `sap-tests`:

```sh
bun run test:idoc     # the tests: Playwright starts a local receiver (no browser, no SAP system)
bun run idoc:server   # the receiver alone: IDoc endpoint on port 47200, control API on 47201
bun run idoc:certs    # test certificates for HTTPS and mutual TLS, in idoc/certs/ (needs openssl)
```

## How it fits together

- **`idoc.mts`** defines the model.
  - The control record holds the fields of `EDI_DC40`.
  - The segments form a tree. Each segment has a type, its fields and its child segments.
  - Field values are always strings, so numbers keep their leading zeros. Empty fields are left out.
  - `findSegments(idoc, 'E1EDP19')` returns every segment of a type at any depth.
- **`xml.mts`** reads and writes IDoc-XML: `parseIdocXml(xml)` and `toIdocXml(idocs, { soap, pretty })`.
  - This is the format of SAP's XML ports (WE21) and of `/sap/bc/idoc_xml`.
  - It reads both plain IDoc-XML and IDoc-XML inside a SOAP envelope, as sent by an XML HTTP port with "SOAP Protocol" ticked. It reports which of the two it got.
- **`rfc.mts`** handles the RFC form: the tables `IDOC_CONTROL_REC_40` and `IDOC_DATA_REC_40` of `IDOC_INBOUND_ASYNCHRONOUS`, which a tRFC port calls.
  - Nothing sends these tables yet. They are ready for tRFC with SNC, through a JCo sidecar or through open-rfc once it supports SNC and tRFC.
  - A data record carries the segment's fields in `SDATA`: one fixed-width string. Reading and writing it therefore needs the field lengths of each segment, a `SegmentLayout`.

- **`inbox.mts`**: what the receiver keeps, in memory: each IDoc with its partner and the reply it got, the raw request bodies, the reply mode per partner, and the requests it refused. It keeps the newest 1,000 IDocs and up to 50 MB of raw bodies.
- **`receiver.mts`**: the receiver, with two listeners like the Mock PLC (it reuses `mfs/http.mts`).
  - **The IDoc endpoint**, which SAP posts to: `POST /idoc/<partner>`. It accepts IDoc-XML plain or in SOAP, in the encoding its XML declaration names. It answers 200, or a SOAP envelope for SOAP.
  - **The control API**, for tests and the app: see below.
- **`sender.mts`**: posts IDocs into SAP. `sendToSap(target, idocs)` writes them as IDoc-XML, fills in `TABNAM` and `DIRECT 2`, and reads SAP's answer: whether SAP took them, the IDoc numbers it gave them, or why it refused. See [Sending into SAP](#sending-into-sap).
- **`fake-sap.mts`**: a stand-in for SAP's two inbound services, for testing the sender without SAP. It numbers the IDocs it takes and can refuse them. It knows nothing of what SAP does with an IDoc after that.
- **`server.mts`**: runs the receiver as a service, set up by environment (the list is at the top of the file). Once ready it prints `IDOC_READY {"idocUrl":…,"controlUrl":…}`, so the app can start it the way it starts the Mock PLC.
- **`certs.mts`**: makes a test CA, a server certificate and a client certificate standing in for SAP's, with openssl. For local use and the tests only.
  - The CA may only vouch for the hosts it was made for (name constraints), and its private key is deleted once both certificates are signed. Trusting it in STRUST therefore can't let it stand in for another server SAP talks to.
  - The private keys are readable by their owner only.

Reading refuses anything that isn't IDoc-XML and says why. It refuses a `DOCTYPE` outright: IDoc-XML never has one, and this rules out entity expansion attacks on the receiver.

## The receiver

### Connecting SAP

1. **SM59:** a type G destination to the receiver's host and port, path prefix `/idoc/<partner>`, for example `/idoc/PWMOCK`. With SSL active and the receiver's CA in STRUST. Either a user and password (`IDOC_USER`, `IDOC_PASSWORD`), or SAP's client certificate: `IDOC_TLS_CA` for the CA that signed it, and `IDOC_TLS_CLIENT_FINGERPRINT` for the certificate itself. The fingerprint matters: without it, every certificate that CA signed would get in.
2. **WE21:** an XML HTTP port using that destination, with or without "SOAP Protocol".
3. **WE20:** the partner profile with outbound parameters for the message types, using that port.

The receiver refuses to start in a way that would open it to the network unprotected. Beyond this computer, the IDoc endpoint needs a TLS certificate and a login: a user and password, or SAP's pinned client certificate. The control API needs a token, and runs over HTTPS with the receiver's certificate.

On this computer without a login, the receiver answers only requests addressed to this computer by name (`localhost`, `127.0.0.1`, `::1`). The IDoc endpoint then also takes only XML (`text/xml`, `application/xml` or `application/soap+xml`). So a web page open in a browser can neither read the IDocs nor send a fake one.

### How it answers

Per partner, set through the control API or `idocInbox.reply`:

| Mode     | SAP sees                                                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accept` | HTTP 200. The default.                                                                                                                                                          |
| `reject` | The given HTTP error (default 500) and message. A SOAP fault for SOAP.                                                                                                          |
| `slow`   | HTTP 200, after the given delay. For testing SAP's timeout. Until the answer has gone out, the IDoc has `answered: false`; if SAP hangs up first, it is marked as not accepted. |

Requests that aren't IDoc-XML get 400 with the reason, and are listed under `GET /failures`.

### Control API

All JSON. With `IDOC_CONTROL_TOKEN` set, every request needs `Authorization: Bearer <token>`, except `GET /health`.

| Request                     | Does                                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /idocs`                | The IDocs received, oldest first, the `cursor` (the newest `seq`) and the `instance` (new at every start). Filters below.                                               |
| `GET /idocs/<seq>`          | One IDoc.                                                                                                                                                               |
| `GET /idocs/<seq>/raw`      | The request it came in: the bytes as SAP sent them, with their encoding.                                                                                                |
| `DELETE /idocs`             | Clears the inbox. Numbering goes on, so a cursor stays valid.                                                                                                           |
| `GET /replies`              | The partners whose reply isn't `accept`, each with `setBy`: `test` while a running test's reply is in effect, otherwise `person`.                                       |
| `PUT /replies/<partner>`    | Sets a partner's reply, for example `{"mode":"reject","status":503,"message":"Partner down"}`. With `?owner=<id>`, the reply holds only until that owner takes it back. |
| `DELETE /replies/<partner>` | Takes back the reply set without an owner; with `?owner=<id>`, only that owner's.                                                                                       |

A partner gets the newest reply an owner set, otherwise the one set without an owner, otherwise `accept`. Tests use owners, so runs that overlap on a shared receiver don't overwrite each other's replies, or a reply a person set.
| `GET /failures` | The newest 100 requests the receiver refused. |
| `GET /info`, `GET /health` | The IDoc endpoint's address; whether the receiver is up. |

Filters for `GET /idocs`: `partner`, `messageType` (MESTYP), `idocType` (IDOCTYP or CIMTYP), `after` (a `seq`), `limit`.

### In tests

Import `test` from `sap-plugin/idoc` and use `idocInbox`. It reads `IDOC_HUB_URL` (the control API) and `IDOC_HUB_TOKEN`, and skips the test without them. `bun run test:idoc` sets both to the local receiver.

```ts
const { idoc } = await idocInbox.waitFor({ partner: 'PWMOCK', messageType: 'ORDRSP' });
expect(findSegments(idoc, 'E1EDK01')[0].fields.BELNR).toBe(orderNumber);
```

- `waitFor` only sees IDocs received since the test started, so IDocs from earlier tests never match. It waits up to 60 s by default, because SAP may send IDocs from a scheduled job. On timeout it lists what did arrive.
  - If the receiver restarts during the test, it numbers from 1 again. The fixture notices by the new `instance`, and then counts everything the restarted receiver holds.
- `where` narrows by anything in the IDoc, for example a document number in a segment.
- `received(match)` returns what has arrived so far.
- `reply(partner, mode)` sets how the receiver answers, until the test ends. The reply belongs to the test: afterwards, whatever applies without it is back, even if other tests set replies meanwhile.

The inbox is shared by everyone using the receiver. Tests that run in parallel against one receiver should match on something unique to them, such as the document number.

## Sending into SAP

The receiver sends IDocs into one SAP system, set when it starts (`server.mts` lists the settings):

| Setting                                 | Means                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| `IDOC_SAP_URL`                          | The SAP system, `https://host:port`. Without it, the receiver only receives.           |
| `IDOC_SAP_CLIENT`                       | The client (`sap-client`).                                                             |
| `IDOC_SAP_SERVICE`                      | `soap` (default) or `xml`, see below.                                                  |
| `IDOC_SAP_USER`, `IDOC_SAP_PASSWORD`    | A user in SAP, for basic authentication.                                               |
| `IDOC_SAP_TLS_CERT`, `IDOC_SAP_TLS_KEY` | A client certificate SAP maps to a user (mutual TLS), instead of or besides the user.  |
| `IDOC_SAP_TLS_CA`                       | A CA to trust for SAP's server certificate, besides the usual ones.                    |
| `IDOC_SAP_TIMEOUT_MS`                   | How long to wait for SAP's answer (default 60 s).                                      |
| `IDOC_FAKE_SAP=1`                       | Send to the stand-in in the receiver's process instead. `bun run test:idoc` does this. |

The two services on the SAP side:

- **`soap`: `/sap/bc/srt/idoc`**, IDoc-XML in a SOAP envelope. This is what CPI's IDoc receiver adapter calls. Register the service with SRTIDOC (or the report `SRT_REGISTER_SERVICE`) and make sure it is active in SICF. SAP answers with the IDoc numbers.
- **`xml`: `/sap/bc/idoc_xml`**, plain IDoc-XML. Active in SICF. Its answer doesn't name the IDoc numbers.

In SAP, the IDocs also need a partner profile (WE20) with inbound parameters for the sender in `SNDPRT`/`SNDPRN` and the message type, and a port matching `SNDPOR` (WE21).

Over `http://` the sender only goes to this computer. A login for SAP needs `IDOC_CONTROL_TOKEN`: otherwise anything on this computer could send IDocs in that user's name. The control API says which kind of login is used, never the login itself.

Control API:

| Request               | Does                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /send`          | Sends `{"xml": "<IDoc-XML>"}` or `{"idocs": [...]}` (all of one type) into SAP. Answers with the send: the IDocs as sent and `result` (`ok`, `status`, `idocNumbers`, `reason`, SAP's `body`). An IDoc marked outbound (`DIRECT 1`) or anything that isn't IDoc-XML gets 400 and isn't sent. If SAP can't be reached or doesn't answer in time, the send is recorded with status 0. |
| `GET /sent`           | The newest 200 sends, oldest first; `?after=<seq>` for the newer ones.                                                                                                                                                                                                                                                                                                              |
| `DELETE /sent`        | Clears the list of sends. Clearing the inbox leaves it.                                                                                                                                                                                                                                                                                                                             |
| `PUT /fake-sap/reply` | Only with `IDOC_FAKE_SAP=1`: how the stand-in answers, `{"mode":"reject","status":500,"message":"…"}` or `{"mode":"accept"}`. For testing a refusal from SAP.                                                                                                                                                                                                                       |
| `GET /info`           | Also gives `sap`: the address, client, service, kind of login and whether it is the stand-in (`standIn`), or `null`.                                                                                                                                                                                                                                                                |

In tests:

```ts
const { result } = await idocSender.send(readFileSync('…/orders05-inbound.xml', 'utf8'));
const [idocNumber] = result.idocNumbers;
// then check the IDoc in SAP (WE02 or BD87: status 53) and the document made from it
```

`send` takes IDoc-XML, one IDoc or several of one type. It fails unless SAP took the IDocs. With `{ expectOk: false }` it returns SAP's refusal instead, for negative tests. The sends are marked as made by a test on the Mock IDoc page.

## Samples

Everything in `samples/` is made up.

| File                    | What it is                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `orders05.xml`          | An order confirmation (`ORDRSP`) of the standard type `ORDERS05`, from SAP to the partner `PWMOCK`. Indented.             |
| `orders05-inbound.xml`  | A purchase order (`ORDERS`) of type `ORDERS05` from the partner `PWMOCK` into SAP, as CPI would send it. `DIRECT 2`.      |
| `orders05-soap.xml`     | The same IDoc in a SOAP envelope, compact, with `ü` and `ö` written as character references.                              |
| `zpwmock01.xml`         | A custom type: two IDocs in one document, three segment levels, a namespaced segment, CDATA, a value with leading spaces. |
| `zpwmock01.layout.json` | The field lengths of `ZPWMOCK01`, needed for the RFC form.                                                                |

## Still to check against a real system

These follow SAP's conventions as far as they are documented, but haven't been compared with IDocs from a real system yet:

- **Extended IDocs:** the root element is the extension (`CIMTYP`), not the basic type.
- **Namespaced names:** `/PWM/Z1NOTE` is written `_-PWM_-Z1NOTE` in XML.
- **SOAP envelope:** the exact form an XML HTTP port sends with "SOAP Protocol" ticked. Reading accepts any prefix and an optional header. Writing uses SOAP 1.1 with an empty header.
- **`HLEVEL`:** top-level segments have level `02` in the RFC form.
- **SAP's answer from `/sap/bc/srt/idoc`:** that it names each IDoc's number in a `DbId` element (CPI passes it on as the header `SapIDocDbId`), and that a refusal is a SOAP fault. The stand-in answers that way. What `/sap/bc/idoc_xml` answers is not known either.
- **The receiver's answers:** that SAP sets status 03 on HTTP 200 whatever the body says, accepts an empty SOAP envelope as the answer to SOAP, and sets an error status on any HTTP error.

A captured IDoc from the RISE dev system settles the first four. Add it to `samples/` once its data is anonymised. The receiver's answers need a test send from SAP to the receiver (WE19, or a business step), with the IDoc statuses checked in WE02. SAP's answer needs one send into the RISE dev system with `IDOC_SAP_URL` set; keep the answer from the Mock IDoc page (technical view) or `GET /sent`.

## Not built yet

- **Loading an IDoc type's XML schema (WE60 export).** It would check IDocs against the type, provide the `SegmentLayout` for the RFC form, and give the app's sender form its fields.
- **Shared storage:** the inbox lives in memory, so it's lost when the receiver stops, and one receiver can't run as several instances.
