// Interactive drawing cards. A widget describes existing controls and arithmetic; the overlay owns all behavior.
(() => {
  const R = window.Roamie;
  const operators = new Map([
    ['+', (a, b) => a + b], ['-', (a, b) => a - b], ['*', (a, b) => a * b],
    ['/', (a, b) => a / b], ['min', Math.min], ['max', Math.max],
  ]);
  const wins = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

  function calculate(formula, values) {
    const stack = [];
    for (const token of formula) {
      const op = operators.get(token);
      if (!op) stack.push(values.has(token) ? values.get(token) : Number(token));
      else {
        const b = stack.pop(), a = stack.pop();
        if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
        stack.push(op(a, b));
      }
    }
    return stack.length === 1 ? stack[0] : NaN;
  }

  function el(tag, name, text) {
    const node = document.createElement(tag);
    if (name) node.className = name;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(label, click) {
    const node = el('button', null, label);
    node.type = 'button';
    node.addEventListener('click', click);
    return node;
  }

  function calculator(panel) {
    const root = el('div'), fields = el('div', 'ink-widget-fields'), results = el('div', 'ink-widget-results');
    const inputs = new Map();
    for (const { id, label, value, suffix } of panel.fields) {
      const field = el('label'), input = el('input');
      input.type = 'number';
      input.step = 'any';
      if (value != null) input.value = String(value);
      field.append(el('span', null, suffix ? `${label} (${suffix})` : label), input);
      fields.append(field);
      inputs.set(id, input);
    }
    const outputs = panel.results.map(({ label, formula, format, currency }) => {
      const row = el('div'), output = el('output');
      row.append(el('span', null, label), output);
      results.append(row);
      const formatter = new Intl.NumberFormat(undefined, format === 'currency' ? { style: 'currency', currency }
        : { style: format === 'percent' ? 'percent' : 'decimal', maximumFractionDigits: 6 });
      return { output, formula, formatter };
    });
    const update = () => {
      const values = new Map(Array.from(inputs, ([id, input]) => [id, input.valueAsNumber]));
      for (const { output, formula, formatter } of outputs) {
        const value = calculate(formula, values);
        output.textContent = Number.isFinite(value) ? formatter.format(value) : '—';
      }
    };
    fields.addEventListener('input', update);
    root.append(fields, results);
    update();
    return root;
  }

  function ticTacToe(onDone) {
    const root = el('div', 'ink-widget-game'), status = el('p'), grid = el('div', 'ink-widget-board');
    status.setAttribute('role', 'status');
    grid.setAttribute('aria-label', 'Tic-tac-toe board');
    const board = Array(9).fill(''), cells = [];
    let mark = 'X', winning = null, done = false;
    const paint = () => {
      status.textContent = winning ? `${mark} wins` : done ? 'Draw' : `${mark}’s turn`;
      cells.forEach((cell, i) => {
        cell.textContent = cell.dataset.mark = board[i];
        cell.setAttribute('aria-label', `Row ${Math.floor(i / 3) + 1}, column ${i % 3 + 1}, ${board[i] || 'empty'}`);
        cell.setAttribute('aria-disabled', String(done || !!board[i]));
        cell.toggleAttribute('data-win', !!winning?.includes(i));
      });
    };
    for (let i = 0; i < board.length; i++) {
      const cell = button('', () => {
        if (done || board[i]) return;
        board[i] = mark;
        winning = wins.find((line) => line.every((j) => board[j] === mark));
        done = !!winning || board.every(Boolean);
        if (!done) mark = mark === 'X' ? 'O' : 'X';
        paint();
        if (done) onDone(status.textContent);
      });
      cells.push(cell);
      grid.append(cell);
    }
    root.append(status, grid);
    paint();
    return root;
  }

  let active = null;
  let takingKeys = false;
  function keyboard(on) {
    if (on === takingKeys) return;
    takingKeys = on;
    R.widgets.setTyping?.(on);
  }

  function close(part = active?.part) {
    if (!active || active.part !== part) return;
    const { root, timer } = active;
    active = null;
    clearTimeout(timer);
    keyboard(false);
    root.remove();
    R.ink?.send?.({ type: 'ink_closed', part });
  }

  function position(safe = R.safe) {
    if (!active) return;
    for (const edge of ['right', 'bottom', 'top']) active.root.style.setProperty(`--widget-${edge}`, `${safe?.[edge] ?? 0}px`);
  }

  function show({ title, part, panels }) {
    if (active?.part === part) return;
    close();
    const root = el('section', 'ink-widget'), heading = el('h2', null, title), tabs = el('div', 'ink-widget-tabs');
    const body = el('div', 'ink-widget-body'), footer = el('footer'), sections = [], buttons = [];
    const card = { root, part, timer: null };
    root.setAttribute('aria-label', title);
    root.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input')) keyboard(true);
    });
    root.addEventListener('focusin', () => keyboard(true));
    root.addEventListener('focusout', (e) => { if (!root.contains(e.relatedTarget)) keyboard(false); });
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close(part);
    });
    panels.forEach((panel, i) => {
      const section = panel.type === 'calculator' ? calculator(panel) : ticTacToe(() => {
        if (panels.length === 1) card.timer = setTimeout(() => close(part), 3200);
      });
      section.hidden = i !== 0;
      body.append(section);
      sections.push(section);
      if (panels.length === 1) return;
      const tab = button(panel.title, () => {
        sections.forEach((page, j) => {
          page.hidden = j !== i;
          buttons[j].setAttribute('aria-pressed', String(j === i));
        });
        body.scrollTop = 0;
      });
      tab.setAttribute('aria-pressed', String(i === 0));
      tabs.append(tab);
      buttons.push(tab);
    });
    footer.append(button('Done', () => close(part)));
    root.append(heading, ...(buttons.length ? [tabs] : []), body, footer);
    active = card;
    position();
    document.body.append(root);
  }

  function rect() {
    const r = active?.root.getBoundingClientRect();
    return r ? [r.left, r.top, r.width, r.height] : null;
  }

  window.addEventListener('blur', () => keyboard(false));
  R.widgets = { show, close, rect, position, setTyping: null,
    get part() { return active?.part; },
    hit(x, y) { const r = rect(); return !!r && x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3]; },
  };
})();
