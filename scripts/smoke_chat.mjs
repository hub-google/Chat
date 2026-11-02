// Live regression smoke test. Creates disposable users and cleans only its own rows.
import assert from 'node:assert/strict';
const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!base || !key || !service) throw new Error('Missing Supabase environment');
const users = [];
const rooms = new Set();
async function call(path, token = key, method = 'GET', body) {
  const response = await fetch(base + path, {
    method, headers: { apikey: token === service ? service : key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path.split('?')[0]}: HTTP ${response.status}`);
  return text ? JSON.parse(text) : null;
}
const rpc = (user, name, args = {}) => call(`/rest/v1/rpc/${name}`, user.access_token, 'POST', args);
try {
  for (let i = 0; i < 3; i++) {
    const user = await call('/auth/v1/signup', key, 'POST', {});
    users.push(user);
    // Auth installs may create this row automatically; only create it if absent.
    const profile = await call(`/rest/v1/profiles?id=eq.${user.user.id}&select=id`, user.access_token);
    if (!profile.length) await call('/rest/v1/profiles', user.access_token, 'POST', { id: user.user.id });
  }
  const [a, b, outsider] = users;
  const args = { p_user_id: a.user.id, p_intent: 'chill', p_lat: -89, p_lng: 90, p_max_distance_km: 1, p_distance_mode: 'nearest' };
  assert.equal((await rpc(a, 'fn_match_user', args))[0].match_id, null);
  const unknown = await rpc(b, 'fn_match_user', { p_user_id: b.user.id, p_intent: 'chill', p_distance_mode: 'unlimited' });
  assert.equal(unknown[0].match_id, null, 'Unknown location must not pass a limited-distance filter');
  await call(`/rest/v1/matching_pool?user_id=eq.${b.user.id}`, b.access_token, 'DELETE');
  const result = await rpc(b, 'fn_match_user', { ...args, p_user_id: b.user.id, p_lng: 90.01 });
  const room = result[0].match_id;
  assert.ok(room);
  rooms.add(room);
  const row = (await call(`/rest/v1/matches?id=eq.${room}&select=distance_km`, a.access_token))[0];
  assert.ok(Number.isFinite(row.distance_km) && row.distance_km >= 0 && row.distance_km < 1);
  assert.equal((await rpc(a, 'fn_match_user', args))[0].match_id, room, 'Retry must reuse the active match');
  assert.deepEqual(await call(`/rest/v1/profiles?id=eq.${b.user.id}&select=*`, a.access_token), []);
  const peer = await rpc(a, 'get_peer_profile', { p_match_id: room });
  assert.deepEqual(Object.keys(peer[0]).sort(), ['age', 'bio', 'city', 'gender']);
  assert.deepEqual(await rpc(outsider, 'get_peer_profile', { p_match_id: room }), []);
  await call('/rest/v1/messages', a.access_token, 'POST', { match_id: room, sender_id: a.user.id, content: 'Disposable deployment regression test', type: 'text' });
  assert.equal((await call(`/rest/v1/messages?match_id=eq.${room}&select=id`, b.access_token)).length, 1);
  assert.deepEqual(await call(`/rest/v1/messages?match_id=eq.${room}&select=id`, outsider.access_token), []);
  assert.deepEqual(await call(`/rest/v1/matches?id=eq.${room}&select=id`, outsider.access_token), []);
  assert.equal(await rpc(a, 'leave_match', { p_match_id: room }), true);
  console.log('PASS: distance calculation/filter, active-room retry, peer privacy, message access, leave');
} finally {
  for (const id of rooms) {
    await call(`/rest/v1/messages?match_id=eq.${id}`, service, 'DELETE');
    await call(`/rest/v1/matches?id=eq.${id}`, service, 'DELETE');
  }
  for (const user of users) await call(`/auth/v1/admin/users/${user.user.id}`, service, 'DELETE');
  console.log('Disposable test accounts and rows cleaned');
}
