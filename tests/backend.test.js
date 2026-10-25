const { call, sheets } = require('./harness.js');
const assert = require('assert');
let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('ok  ', name); } catch (e) { console.log('FAIL', name, '\n   ', e.message); process.exitCode = 1; } };

const names = ['Alex','Ben','Carlo','Dan','Eli','Fay','Gus','Hal','Ira','Jo'];
let r = call('POST', { action: 'createSession', name: 'Friday', courtCount: 2, players: names, password: 'secret1' });
assert(r.ok, JSON.stringify(r));
const { sessionId, publicToken, adminToken } = r.data;
const adm = (action, extra = {}) => call('POST', Object.assign({ action, sessionId, adminToken }, extra));
const pub = () => call('GET', { action: 'getPublicSession', token: publicToken });

t('create fills 2 courts in order w/ exact messages', () => {
  const s = pub().data;
  assert.equal(s.courts[0].match.players.map(p => p.name).join(), 'Alex,Ben,Carlo,Dan');
  assert.equal(s.courts[1].match.players.map(p => p.name).join(), 'Eli,Fay,Gus,Hal');
  assert.equal(s.notifications.length, 2);
  assert.equal(s.notifications[0].message, 'Players Alex, Ben, Carlo, and Dan, please proceed to Court No. 1.');
  assert.equal(s.queue.map(q => q.name).join(), 'Ira,Jo');
  assert(!s.courts[0].match.matchId && !s.session.publicToken && !s.session.sessionId, 'public leaks');
});
t('bad token / wrong password / bad admin token', () => {
  assert.equal(call('GET', { action: 'getPublicSession', token: 'x' }).error.code, 'INVALID_TOKEN');
  assert.equal(call('GET', { action: 'getPublicSession', token: 'a'.repeat(32) }).error.code, 'NOT_FOUND');
  assert.equal(call('POST', { action: 'adminLogin', sessionId, password: 'nope' }).error.code, 'INVALID_CREDENTIALS');
  assert.equal(call('POST', { action: 'addPlayers', sessionId, adminToken: 'bad', names: ['Z'] }).error.code, 'UNAUTHORIZED');
  assert.equal(call('POST', { action: 'addPlayers', sessionId: 'S_other', adminToken, names: ['Z'] }).error.code, 'UNAUTHORIZED');
  assert.equal(call('GET', { action: 'addPlayers' }).error.code, 'METHOD_NOT_ALLOWED');
  const login = call('POST', { action: 'adminLogin', sessionId, password: 'secret1' });
  assert(login.ok && login.data.adminToken);
});
t('no plaintext password stored', () => {
  const dump = JSON.stringify(sheets.SessionAdmins.rows);
  assert(!dump.includes('secret1') && dump.includes('v1$'));
});
let a = adm('getAdminSession').data.state;
const m1 = a.courts[0].match.matchId, m2 = a.courts[1].match.matchId;
t('complete court 1: players to end, Ira+Jo+Alex+Ben assigned, others untouched', () => {
  const r = adm('completeMatch', { matchId: m1, winningTeam: 'A', score: '21-15', requestId: 'r1' });
  assert(r.ok, JSON.stringify(r));
  const s = r.data.state;
  assert.equal(s.courts[0].match.players.map(p => p.name).join(), 'Ira,Jo,Alex,Ben');
  assert.equal(s.courts[1].match.players.map(p => p.name).join(), 'Eli,Fay,Gus,Hal');
  assert.equal(s.queue.map(q => q.name).join(), 'Carlo,Dan');
  const last = s.notifications[s.notifications.length - 1];
  assert.equal(last.message, 'Players Ira, Jo, Alex, and Ben, please proceed to Court No. 1.');
  assert.equal(s.notifications.length, 3);
});
t('duplicate submission (same requestId) replays; (new requestId, same result) is no-op; different result rejected', () => {
  const before = adm('getAdminSession').data.state.notifications.length;
  assert(adm('completeMatch', { matchId: m1, winningTeam: 'A', score: '21-15', requestId: 'r1' }).ok);
  assert(adm('completeMatch', { matchId: m1, winningTeam: 'A', score: '21-15', requestId: 'r2' }).ok);
  assert.equal(adm('completeMatch', { matchId: m1, winningTeam: 'B', score: '' }).error.code, 'ALREADY_COMPLETED');
  const s = adm('getAdminSession').data.state;
  assert.equal(s.notifications.length, before);
  const stat = n => s.stats.find(x => x.name === n);
  assert.equal(stat('Alex').games, 1); assert.equal(stat('Alex').wins, 1);
  assert.equal(stat('Carlo').losses, 1); assert.equal(stat('Carlo').winRate, 0);
});
t('score validation', () => {
  const s = adm('getAdminSession').data.state;
  const id = s.courts[1].match.matchId;
  assert.equal(adm('completeMatch', { matchId: id, winningTeam: 'A', score: '10-21' }).error.code, 'INVALID_SCORE');
  assert.equal(adm('completeMatch', { matchId: id, winningTeam: 'C' }).error.code, 'INVALID_RESULT');
  assert.equal(adm('completeMatch', { matchId: id, winningTeam: 'A', score: 'abc' }).error.code, 'INVALID_SCORE');
});
t('two courts finishing back-to-back: no player double-assigned', () => {
  adm('completeMatch', { matchId: m2, winningTeam: 'B', score: '' });
  const s = adm('getAdminSession').data.state;
  const ids = [];
  s.courts.forEach(c => c.match && c.match.players.forEach(p => ids.push(p.playerId)));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 8);
});
t('correct result recalculates without double counting', () => {
  let s = adm('getAdminSession').data.state;
  const mm = s.matches.find(m => m.matchId === m1);
  assert(adm('correctMatch', { matchId: m1, winningTeam: 'B', score: '15-21' }).ok);
  s = adm('getAdminSession').data.state;
  const st = n => s.stats.find(x => x.name === n);
  assert.equal(st('Alex').wins, 0); assert.equal(st('Alex').losses, 1); assert.equal(st('Alex').games, 1);
  assert.equal(st('Carlo').wins, 1);
  assert.equal(st('Carlo').history[0].score, '21-15'.split('-').reverse().join('-') === '15-21' ? '21-15' : '');
});
t('void completed match removes stats', () => {
  assert(adm('cancelMatch', { matchId: m1 }).ok);
  const s = adm('getAdminSession').data.state;
  assert.equal(s.stats.find(x => x.name === 'Alex').games, 0);
});
t('remove a playing player: stays until match ends, then LEFT, not requeued', () => {
  let s = adm('getAdminSession').data.state;
  const c1 = s.courts[0];
  const victim = c1.match.players[0];
  const r = adm('removePlayer', { playerId: victim.playerId });
  assert(r.ok && r.data.result.leavesAfterMatch);
  adm('completeMatch', { matchId: c1.match.matchId, winningTeam: 'A' });
  s = adm('getAdminSession').data.state;
  assert(!s.queue.some(q => q.playerId === victim.playerId));
  assert(!s.courts.some(c => c.match && c.match.players.some(p => p.playerId === victim.playerId)));
  const pl = s.players.find(p => p.playerId === victim.playerId);
  assert.equal(pl.status, 'LEFT');
  assert.equal(s.stats.find(x => x.playerId === victim.playerId).games, 1); // history kept
});
t('insufficient players: court stays available with message, no notification; adding a 4th fires one', () => {
  const r2 = call('POST', { action: 'createSession', name: 'Small', courtCount: 1, players: ['P1','P2','P3'], password: 'abcdef' });
  const adm2 = (action, extra = {}) => call('POST', Object.assign({ action, sessionId: r2.data.sessionId, adminToken: r2.data.adminToken }, extra));
  let s = adm2('getAdminSession').data.state;
  assert.equal(s.notifications.length, 0);
  assert.equal(s.courts[0].message, 'Court No. 1 is available. Waiting for more players.');
  assert.equal(adm2('startMatch', { courtId: s.courts[0].courtId }).error.code, 'INSUFFICIENT_PLAYERS');
  s = adm2('addPlayers', { names: ['P4'] }).data.state;
  assert.equal(s.notifications.length, 1);
  assert.equal(s.notifications[0].message, 'Players P1, P2, P3, and P4, please proceed to Court No. 1.');
  assert.equal(s.courts[0].message, '');
});
t('unavailable players are skipped; duplicates rejected', () => {
  let s = adm('getAdminSession').data.state;
  assert.equal(adm('addPlayers', { names: ['Zed'] }).ok, true);
  assert.equal(adm('addPlayers', { names: ['zed'] }).error.code, 'DUPLICATE_NAME');
  s = adm('getAdminSession').data.state;
  const z = s.queue.find(q => q.name === 'Zed');
  if (z) {
    adm('setPlayerStatus', { playerId: z.playerId, status: 'UNAVAILABLE' });
    s = adm('getAdminSession').data.state;
    assert(!s.queue.some(q => q.name === 'Zed'));
    assert(!s.courts.some(c => c.match && c.match.players.some(p => p.name === 'Zed')));
  }
});
t('reorder queue validated', () => {
  const s = adm('getAdminSession').data.state;
  const ids = s.queue.map(q => q.playerId);
  if (ids.length >= 2) {
    const sw = ids.slice(); [sw[0], sw[1]] = [sw[1], sw[0]];
    assert(adm('reorderQueue', { playerIds: sw }).ok);
    assert.equal(adm('reorderQueue', { playerIds: ids.slice(1) }).error.code, 'QUEUE_CHANGED');
  }
});
t('cancel in-progress match: players front of queue, court not instantly refilled', () => {
  let s = adm('getAdminSession').data.state;
  const c = s.courts.find(x => x.match);
  const nBefore = s.notifications.length;
  const ids = c.match.players.map(p => p.name);
  assert(adm('cancelMatch', { matchId: c.match.matchId }).ok);
  s = adm('getAdminSession').data.state;
  assert.equal(s.notifications.length, nBefore);
  assert.deepEqual(s.queue.slice(0, 4).map(q => q.name), ids);
  const fc = adm('fillCourts');
  assert(fc.ok);
});
t('manual swap of match player + notification', () => {
  let s = adm('getAdminSession').data.state;
  const c = s.courts.find(x => x.match);
  if (!s.queue.length) { adm('addPlayers', { names: ['Extra1'] }); s = adm('getAdminSession').data.state; }
  const ids = c.match.players.map(p => p.playerId);
  const incoming = s.queue[0].playerId;
  const r = adm('setMatchPlayers', { matchId: c.match.matchId, playerIds: [incoming, ids[1], ids[2], ids[3]] });
  assert(r.ok, JSON.stringify(r));
  assert.equal(r.data.state.queue.some(q => q.playerId === ids[0]), true);
  assert.equal(adm('setMatchPlayers', { matchId: c.match.matchId, playerIds: [ids[0], ids[0], ids[2], ids[3]] }).error.code, 'INVALID_PLAYERS');
});
t('court count change', () => {
  assert(adm('setCourtCount', { courtCount: 3 }).ok);
  assert.equal(adm('getAdminSession').data.state.courts.length, 3);
  const r = adm('setCourtCount', { courtCount: 1 });
  assert(r.ok || r.error.code === 'COURT_BUSY');
});
t('close session: read-only, matches cancelled, public still readable', () => {
  assert(adm('closeSession').ok);
  assert.equal(adm('addPlayers', { names: ['Late'] }).error.code, 'SESSION_CLOSED');
  const s = pub().data;
  assert.equal(s.session.status, 'CLOSED');
  assert(s.courts.every(c => !c.match));
  assert(adm('closeSession').ok);
});
t('sessions are isolated', () => {
  const r2 = call('POST', { action: 'createSession', name: 'Other', courtCount: 1, players: ['A1','A2','A3','A4','A5'], password: 'abcdef' });
  const p2 = call('GET', { action: 'getPublicSession', token: r2.data.publicToken }).data;
  assert.equal(p2.notifications.length, 1);
  assert(!p2.notifications[0].message.includes('Alex'));
  assert.equal(p2.stats.length, 5);
});
console.log(`\n${pass} passed`);
