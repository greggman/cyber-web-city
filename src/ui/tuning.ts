// Live tuning sliders for the handling feel (?tune=1). Changes apply at
// once, are remembered in this browser, and "Copy" puts the values on the
// clipboard (to paste back as the new defaults in camera/drive.ts).
const CSS = `
#ui-tuning {
  position: fixed; left: 10px; bottom: 40px; z-index: 10; width: 260px;
  max-width: calc(100vw - 20px); padding: 8px;
  background: rgba(8, 6, 18, 0.82); border: 1px solid rgba(120, 255, 255, 0.35);
  border-radius: 10px; color: #cfe; font: 12px/1.3 ui-monospace, monospace;
}
#ui-tuning h3 {
  margin: 2px 4px 6px; font-size: 10px; letter-spacing: .15em;
  color: rgba(255, 120, 230, 0.8); text-transform: uppercase;
}
#ui-tuning .row { display: flex; align-items: center; gap: 8px; padding: 2px 4px; }
#ui-tuning label { flex: 1; }
#ui-tuning input { width: 100px; accent-color: #f5c; }
#ui-tuning output { width: 40px; text-align: right; color: #8ff; }
#ui-tuning button {
  margin: 6px 4px 0 0; padding: 4px 10px; border-radius: 6px; cursor: pointer;
  background: none; border: 1px solid rgba(255, 120, 230, 0.5); color: #f9e; font: inherit;
}
`;

const RANGES: Record<string, [number, number]> = {
  turnRate: [0.2, 2],
  turnLag: [0.02, 1],
  reverseLag: [0.01, 0.5],
  wheelIn: [0.05, 3],
  wheelOut: [0.05, 3],
  counterIn: [0.05, 3],
  liftIn: [0.05, 3],
  liftOut: [0.05, 3],
  bankLag: [0.05, 1.5],
};
const KEY = 'cyber-web-city-tuning';

export function showTuning(values: Record<string, number>) {
  const defaults = {...values};
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    for (const k of Object.keys(values)) {
      if (typeof saved[k] === 'number') values[k] = saved[k];
    }
  } catch {
    // No storage (private window): just use the defaults.
  }
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(values));
    } catch {
      // Not remembered; still applied.
    }
  };
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const box = document.createElement('div');
  box.id = 'ui-tuning';
  // Don't let clicks here grab the orbit camera or close menus.
  box.addEventListener('pointerdown', e => e.stopPropagation());
  const h = document.createElement('h3');
  h.textContent = 'Handling';
  box.appendChild(h);
  const inputs: [string, HTMLInputElement, HTMLOutputElement][] = [];
  for (const k of Object.keys(values)) {
    const [min, max] = RANGES[k] ?? [0, 2];
    const row = document.createElement('div');
    row.className = 'row';
    const l = document.createElement('label');
    l.textContent = k;
    l.htmlFor = `tune-${k}`;
    const input = document.createElement('input');
    input.type = 'range';
    input.id = `tune-${k}`;
    input.min = String(min);
    input.max = String(max);
    input.step = '0.01';
    const out = document.createElement('output');
    const show = () => {
      input.value = String(values[k]);
      out.textContent = values[k].toFixed(2);
    };
    input.addEventListener('input', () => {
      values[k] = Number(input.value);
      out.textContent = values[k].toFixed(2);
      save();
    });
    show();
    inputs.push([k, input, out]);
    row.append(l, input, out);
    box.appendChild(row);
  }
  const copy = document.createElement('button');
  copy.textContent = 'Copy';
  copy.addEventListener('click', () => {
    const text = JSON.stringify(values, null, 2);
    void navigator.clipboard?.writeText(text).then(() => {
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy'), 1500);
    });
  });
  const reset = document.createElement('button');
  reset.textContent = 'Reset';
  reset.addEventListener('click', () => {
    Object.assign(values, defaults);
    for (const [k, input, out] of inputs) {
      input.value = String(values[k]);
      out.textContent = values[k].toFixed(2);
    }
    save();
  });
  box.append(copy, reset);
  document.body.appendChild(box);
}
