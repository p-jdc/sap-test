<script lang="ts">
	import { errorMessage } from '#lib/client/run-actions.js';
	import {
		blockPerson,
		createInvite,
		getActivity,
		getMe,
		getPeople,
		removePerson,
		setPersonRole
	} from '#lib/remote/people.remote.js';

	// Shown with sign-in on, to admins: who has access, invite links and what happened.
	const people = getPeople();
	const activity = getActivity();
	const me = getMe();

	let name = $state('');
	let role = $state<'admin' | 'member'>('member');
	let link = $state<{ url: string; name: string; expiresAt: string } | null>(null);
	let error = $state<string | null>(null);
	let busy = $state(false);

	const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');

	async function invite() {
		busy = true;
		error = null;
		try {
			const who = name.trim();
			const { token, expiresAt } = await createInvite({ name: who, role });
			link = { url: `${location.origin}/signin?invite=${token}`, name: who, expiresAt };
			name = '';
		} catch (e) {
			error = errorMessage(e);
		} finally {
			busy = false;
		}
	}

	async function act(action: () => Promise<unknown>) {
		error = null;
		try {
			await action();
		} catch (e) {
			error = errorMessage(e);
		}
	}

	const remove = (id: string, who: string) =>
		confirm(`Remove ${who}? Their passkeys stop working at once.`) &&
		act(() => removePerson({ id }));
</script>

<ui5-card>
	<ui5-card-header
		slot="header"
		title-text="People"
		subtitle-text="Who can sign in. Admins change these settings and invite others."
	></ui5-card-header>
	<div class="card-body">
		{#if error}
			<ui5-message-strip design="Negative" onclose={() => (error = null)}>
				{error}
			</ui5-message-strip>
		{/if}
		<table class="list">
			<thead>
				<tr><th>Name</th><th>Role</th><th>Passkeys</th><th>Last sign-in</th><th></th></tr>
			</thead>
			<tbody>
				{#each people.current ?? [] as person (person.id)}
					<tr data-person={person.name}>
						<td>{person.name}{person.blocked ? ' (blocked)' : ''}</td>
						<td>{person.role}</td>
						<td>{person.passkeys}</td>
						<td>{when(person.lastSignIn)}</td>
						<td class="actions">
							{#if person.id !== me.current?.user?.id}
								<ui5-button
									design="Transparent"
									onclick={() =>
										act(() =>
											setPersonRole({
												id: person.id,
												role: person.role === 'admin' ? 'member' : 'admin'
											})
										)}
								>
									{person.role === 'admin' ? 'Make member' : 'Make admin'}
								</ui5-button>
								<ui5-button
									design="Transparent"
									onclick={() =>
										act(() => blockPerson({ id: person.id, blocked: !person.blocked }))}
								>
									{person.blocked ? 'Unblock' : 'Block'}
								</ui5-button>
								<ui5-button design="Transparent" onclick={() => remove(person.id, person.name)}>
									Remove
								</ui5-button>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>

		<div class="invite">
			<ui5-label for="invite-name" show-colon>Invite</ui5-label>
			<ui5-input
				id="invite-name"
				placeholder="Their name"
				value={name}
				oninput={(e: Event) => (name = (e.target as HTMLInputElement).value)}
			></ui5-input>
			<ui5-select
				accessible-name="Role"
				onchange={(e: CustomEvent<{ selectedOption: HTMLElement }>) =>
					(role = e.detail.selectedOption.dataset.value === 'admin' ? 'admin' : 'member')}
			>
				<ui5-option data-value="member" selected={role === 'member' || undefined}>
					Member
				</ui5-option>
				<ui5-option data-value="admin" selected={role === 'admin' || undefined}>Admin</ui5-option>
			</ui5-select>
			<ui5-button design="Emphasized" disabled={busy || !name.trim() || undefined} onclick={invite}>
				Create invite link
			</ui5-button>
		</div>
		{#if link}
			<ui5-message-strip design="Information" onclose={() => (link = null)}>
				Send this link to {link.name}. It works once, until {when(link.expiresAt)}, and is not shown
				again:
				<span class="mono link" data-invite-link>{link.url}</span>
			</ui5-message-strip>
		{/if}
	</div>
</ui5-card>

<ui5-card>
	<ui5-card-header
		slot="header"
		title-text="Activity"
		subtitle-text="Sign-ins, runs, recordings and changes, newest first. Kept on this computer."
	></ui5-card-header>
	<div class="card-body">
		<table class="list">
			<thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
			<tbody>
				{#each activity.current ?? [] as entry, i (i)}
					<tr>
						<td>{when(entry.at)}</td>
						<td>{entry.who ?? '–'}</td>
						<td>{entry.action}{entry.detail ? `: ${entry.detail}` : ''}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</ui5-card>

<style>
	.list {
		width: 100%;
		border-collapse: collapse;
	}
	.list th,
	.list td {
		text-align: left;
		padding: 0.25rem 0.5rem;
		border-bottom: 1px solid var(--sapList_BorderColor);
	}
	.actions {
		white-space: nowrap;
	}
	.invite {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.link {
		display: block;
		word-break: break-all;
		margin-top: 0.25rem;
	}
</style>
