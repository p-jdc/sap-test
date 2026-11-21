# IDoc model

One model for IDocs, used by the tests, the sample data and later by the mock hub and the app. It doesn't depend on how an IDoc travels.

The transports come later and use this model:

- a receiver for the IDocs SAP sends (local issue L03);
- a sender (L05);
- tRFC with SNC.

## Try it

From `sap-tests`:

```sh
bun run test:idoc   # the tests (no browser, no SAP system)
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

Reading refuses anything that isn't IDoc-XML and says why. It refuses a `DOCTYPE` outright: IDoc-XML never has one, and this rules out entity expansion attacks once the mock hub accepts IDocs over the network.

## Samples

Everything in `samples/` is made up.

| File                    | What it is                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `orders05.xml`          | An order confirmation (`ORDRSP`) of the standard type `ORDERS05`, from SAP to the partner `PWMOCK`. Indented.             |
| `orders05-soap.xml`     | The same IDoc in a SOAP envelope, compact, with `ü` and `ö` written as character references.                              |
| `zpwmock01.xml`         | A custom type: two IDocs in one document, three segment levels, a namespaced segment, CDATA, a value with leading spaces. |
| `zpwmock01.layout.json` | The field lengths of `ZPWMOCK01`, needed for the RFC form.                                                                |

## Still to check against a real system

These follow SAP's conventions as far as they are documented, but haven't been compared with IDocs from a real system yet:

- **Extended IDocs:** the root element is the extension (`CIMTYP`), not the basic type.
- **Namespaced names:** `/PWM/Z1NOTE` is written `_-PWM_-Z1NOTE` in XML.
- **SOAP envelope:** the exact form an XML HTTP port sends with "SOAP Protocol" ticked. Reading accepts any prefix and an optional header. Writing uses SOAP 1.1 with an empty header.
- **`HLEVEL`:** top-level segments have level `02` in the RFC form.

A captured IDoc from the RISE dev system (L12) answers all four. Add it to `samples/` once its data is anonymised.

## Not built yet

- **Loading an IDoc type's XML schema (WE60 export).** It would check IDocs against the type, provide the `SegmentLayout` for the RFC form, and give the app's sender form its fields (L11).
