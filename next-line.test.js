const { test } = require('node:test'), assert = require('node:assert/strict'), model = require('./public/next-line-model');
const lines = [{ id: 5, start: 1, character: 'B', owner: 'Me' }, { id: 4, start: 10, character: 'A', owner: 'Me' }, { id: 1, start: 2, character: 'A', owner: 'Me' }, { id: 2, start: 4, character: 'A', owner: 'Me', audioUrl: '/a.wav' }, { id: 3, start: 6, character: 'A', owner: 'Other' }];
const options = { nick: 'Me', owner: line => line.owner };
test('next unrecorded line prioritizes current role over earlier other roles', () => { assert.equal(model.next(lines, 2, options).id, 4); });
test('current role wraps to earlier unrecorded lines before changing roles', () => { assert.equal(model.next(lines, 4, options).id, 1); });
test('completed current role moves to earliest unrecorded line in another owned role', () => { assert.equal(model.next(lines.filter(l => l.id !== 1 && l.id !== 4), 2, options).id, 5); });
test('no selection chooses earliest owned line and chronological ties use immutable ids', () => { assert.equal(model.next(lines, null, options).id, 5); assert.equal(model.next([{id:9,start:1,owner:'Me'},{id:8,start:1,owner:'Me'}], null, options).id, 8); });
test('current line, foreign assignments, recorded and live-capture candidates are excluded', () => { assert.equal(model.next(lines, 1, {...options,available:l=>l.id!==4}).id, 5); assert.equal(model.next(lines, 2, {...options,nick:'Absent'}), null); assert.equal(model.next([{id:1,start:1,owner:'Me'}], 1, options), null); });
test('single-player effective ownership includes all available roles without modifying claims', () => { const before=JSON.stringify(lines); assert.equal(model.next(lines, 2, {...options,owner:()=> 'Me'}).id, 3); assert.equal(JSON.stringify(lines), before); });
