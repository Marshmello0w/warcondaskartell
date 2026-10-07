import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireOrgRole, requireOwner } from '$lib/server/access';
import {
	deleteOrg,
	setBanMessage,
	setBanReasonPresets,
	setMembersReserved,
	setOrgControls,
	updateOrg
} from '$lib/server/orgs';

/**
 * {name}, {discordInviteUrl}, {membersReserved}, {banMessage} or {banReasonPresets} for org owners; {serverLimit, suspended,
 * reason, allowPublicStatus, allowPublicLeaderboards} for the site owner only.
 */
export const PATCH = route(async (event) => {
	const env = getEnv();
	const body = await readJson(event.request);
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	if (
		body.serverLimit !== undefined ||
		body.suspended !== undefined ||
		body.allowPublicStatus !== undefined ||
		body.allowPublicLeaderboards !== undefined
	) {
		requireOwner(event.locals);
		await setOrgControls(env, event.request, user, org, body);
	} else if (body.membersReserved !== undefined) {
		const sync = await setMembersReserved(env, event.request, user, org, !!body.membersReserved);
		return apiJson({ ok: true, sync });
	} else if (body.banMessage !== undefined) {
		const banMessage = await setBanMessage(env, event.request, user, org, body.banMessage);
		return apiJson({ ok: true, banMessage });
	} else if (body.banReasonPresets !== undefined) {
		const banReasonPresets = await setBanReasonPresets(
			env,
			event.request,
			user,
			org,
			body.banReasonPresets
		);
		return apiJson({ ok: true, banReasonPresets });
	} else {
		await updateOrg(env, event.request, user, org, body);
	}
	return apiJson({ ok: true });
});

export const DELETE = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	await deleteOrg(env, event.request, user, org);
	return apiJson({ ok: true });
});
