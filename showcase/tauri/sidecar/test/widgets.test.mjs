import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { checkDraw, DrawArgs } from '../draw.mjs';
import { createTools } from '../tools.mjs';

const calculator = { type: 'calculator', title: 'Estimate', fields: [
  { id: 'revenue', label: 'Revenue', value: 100 }, { id: 'cost', label: 'Cost', value: 40 },
], results: [{ label: 'Profit', formula: ['revenue', 'cost', '-'] }] };
const game = { type: 'tic_tac_toe', title: 'Tic-tac-toe' };
const mark = { kind: 'widget', title: 'Two tools', panels: [calculator, game] };
const drawing = (...marks) => DrawArgs.parse({ beats: [{ say: '', marks }] });
assert.deepEqual(checkDraw(drawing(mark)), []);
assert.match(checkDraw(drawing(mark, mark))[0], /one widget mark/);
assert.match(checkDraw(drawing({ ...mark, panels: [{ ...calculator, results: [{ label: 'Bad', formula: ['revenue', 'missing', '-'] }] }] }))[0], /postfix formula/);

const rendered = [];
const app = createTools({
  ui: ({ e }) => {
    if (e?.type !== 'draw') return;
    rendered.push(e.beats[0].marks[0]);
    queueMicrotask(() => app.ink.started(e.id, e.seg));
  },
});
const draw = app.tools.find((tool) => tool.name === 'draw');
app.nextTurn();
await Promise.all([draw.execute(drawing(mark), { toolCallId: 'one' }), draw.execute(drawing(mark), { toolCallId: 'two' })]);
assert.equal(rendered.length, 1, 'concurrent duplicate calls produce a single widget');
app.nextTurn();
await draw.execute(drawing(mark), { toolCallId: 'three' });
assert.equal(rendered.length, 2, 'a later request can open a widget');

function element(tag) {
  const events = {};
  const node = {
    tag, children: [], dataset: {}, style: { setProperty() {} },
    append(...children) { for (const child of children) child.parent = node; node.children.push(...children); },
    remove() { node.parent.children = node.parent.children.filter((child) => child !== node); },
    addEventListener(name, handler) { events[name] = handler; },
    fire(name) { events[name]?.({}); },
    setAttribute() {}, toggleAttribute() {},
    get valueAsNumber() { return node.value ? Number(node.value) : NaN; },
  };
  return node;
}
const document = { body: element('body'), createElement: element };
const closed = [];
const Roamie = { ink: { send: (event) => closed.push(event.part) } };
let timer;
vm.runInNewContext(fs.readFileSync(new URL('../../../roamies/widget-ui.js', import.meta.url), 'utf8'), {
  window: { Roamie, addEventListener() {} }, document, setTimeout(callback) { timer = callback; }, clearTimeout() {},
});
const { widgets } = Roamie;
const [first, second] = rendered;
widgets.show(first);
widgets.show(first);
assert.equal(document.body.children.length, 1);
const [heading, tabs, body] = document.body.children[0].children;
const [estimator, board] = body.children;
const [fields, results] = estimator.children;
const output = results.children[0].children[1];
assert.equal(heading.textContent, 'Two tools');
assert.equal(output.textContent, '60');
fields.children[0].children[1].value = '125';
fields.fire('input');
assert.equal(output.textContent, '85');
assert.equal(board.hidden, true);
tabs.children[1].fire('click');
assert.equal(estimator.hidden, true);
assert.equal(board.hidden, false);
widgets.show(second);
assert.deepEqual(closed, [first.part]);
assert.equal(document.body.children.length, 1);
document.body.children[0].children.at(-1).children[0].fire('click');
assert.equal(document.body.children.length, 0);
widgets.show({ ...mark, part: 'game', panels: [game] });
const gameBody = document.body.children[0].children[1].children[0];
const [status, cells] = gameBody.children;
for (const i of [0, 3, 1, 4, 2]) cells.children[i].fire('click');
assert.equal(status.textContent, 'X wins');
timer();
assert.equal(document.body.children.length, 0);
assert.deepEqual(closed, [first.part, second.part, 'game']);
console.log('widget tests: passed');
