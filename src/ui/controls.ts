// On-screen controls: a camera button (top left) and a settings button (top
// right), each opening a small neon panel. Plain DOM, no libraries.
// Settings persist per browser in localStorage (best effort).

export const enum CameraMode {
  Chase = 0,
  Cockpit = 1,
  Skyline = 2,
  Map = 3,
}

export interface UiState {
  camera: CameraMode;
  /** Chase framing 0-4, or undefined to cycle automatically. */
  shot: number | undefined;
  paused: boolean;
  sound: boolean;
  volume: number;
  hud: boolean;
  timeScale: number;
  rain: number;
  haze: number;
  exposure: number;
  ssr: boolean;
  volumetrics: boolean;
  taa: boolean;
  details: boolean;
  ao: boolean;
}

export const DEFAULTS: UiState = {
  camera: CameraMode.Chase,
  shot: undefined,
  paused: false,
  sound: true,
  volume: 0.8,
  hud: false,
  timeScale: 1,
  rain: 1,
  haze: 1,
  exposure: 1,
  ssr: true,
  volumetrics: true,
  taa: true,
  details: true,
  ao: true,
};

const STORAGE_KEY = 'cyber-web-city/settings';
// Persisted keys (camera choice and pause are per session).
const PERSIST: (keyof UiState)[] = [
  'sound',
  'volume',
  'hud',
  'timeScale',
  'rain',
  'haze',
  'exposure',
  'ssr',
  'volumetrics',
  'taa',
  'details',
  'ao',
];

export function loadSaved(): Partial<UiState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of PERSIST) {
      if (typeof obj[k] === typeof DEFAULTS[k]) out[k] = obj[k];
    }
    return out as Partial<UiState>;
  } catch {
    return {};
  }
}

function save(s: UiState) {
  try {
    const obj: Record<string, unknown> = {};
    for (const k of PERSIST) obj[k] = s[k];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // Storage unavailable (private mode etc.): settings just won't persist.
  }
}

const CAMERA_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h3l2-2.5h6L17 7h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.6"/></svg>';
const GEAR_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.8l1.6 2.4 2.8-.7.7 2.8 2.4 1.6-1.2 2.6 1.2 2.6-2.4 1.6-.7 2.8-2.8-.7L12 21.2l-1.6-2.4-2.8.7-.7-2.8-2.4-1.6 1.2-2.6-1.2-2.6 2.4-1.6.7-2.8 2.8.7z"/></svg>';

const GLOBE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2M12 3.4c2.6 2.4 3.8 5.3 3.8 8.6s-1.2 6.2-3.8 8.6M12 3.4C9.4 5.8 8.2 8.7 8.2 12s1.2 6.2 3.8 8.6"/></svg>';
const WHEEL_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="2.2"/><path d="M3.6 10.6h6.3M14.1 10.6h6.3M12 14.2v6.2"/></svg>';
const SOUND_ON_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6"/><path d="M18 6.5a7.6 7.6 0 0 1 0 11"/></svg>';
const SOUND_OFF_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/></svg>';

const CSS = `
.ui-btn {
  position: fixed; top: 10px; width: 38px; height: 38px; padding: 0;
  display: grid; place-items: center; cursor: pointer; z-index: 10;
  background: rgba(8, 6, 18, 0.55); border: 1px solid rgba(120, 255, 255, 0.35);
  border-radius: 8px; color: #8ff; backdrop-filter: blur(4px);
  transition: border-color .15s, box-shadow .15s, color .15s;
}
.ui-btn:hover, .ui-btn[aria-expanded="true"] {
  border-color: #6ff; color: #cff; box-shadow: 0 0 10px rgba(80, 255, 255, 0.45);
}
.ui-btn:focus-visible { outline: 2px solid #f6f; outline-offset: 2px; }
.ui-btn svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linejoin: round; }
#ui-cam-btn { left: 10px; }
#ui-gear-btn { right: 10px; }
#ui-theme-btn { left: 56px; }
#ui-drive-btn { left: 102px; }
#ui-drive-btn.on { color: #f9f; border-color: rgba(255, 120, 255, 0.7); box-shadow: 0 0 10px rgba(255, 110, 255, 0.45); }
#ui-sound-btn { right: 56px; }
/* Invite a click while silent. */
#ui-sound-btn.off { color: #f9f; border-color: rgba(255, 120, 255, 0.55); animation: ui-pulse 2.4s ease-in-out infinite; }
@keyframes ui-pulse { 50% { box-shadow: 0 0 12px rgba(255, 110, 255, 0.6); } }
.ui-panel {
  position: fixed; top: 54px; z-index: 10; min-width: 210px; max-width: calc(100vw - 20px);
  max-height: calc(100vh - 70px); overflow-y: auto; padding: 8px;
  background: rgba(8, 6, 18, 0.82); border: 1px solid rgba(120, 255, 255, 0.35);
  border-radius: 10px; color: #cfe; font: 12px/1.3 ui-monospace, monospace;
  backdrop-filter: blur(6px); box-shadow: 0 0 24px rgba(255, 60, 200, 0.15);
  touch-action: pan-y; /* the panel can still scroll on small screens */
}
.ui-panel[hidden] { display: none; }
#ui-toast {
  position: fixed; left: 10px; top: 54px; z-index: 10; padding: 5px 10px;
  background: rgba(8, 6, 18, 0.82); border: 1px solid rgba(120, 255, 255, 0.35);
  border-radius: 8px; color: #8ff; font: 12px ui-monospace, monospace;
  opacity: 0; transition: opacity .3s; pointer-events: none;
}
#ui-toast.show { opacity: 1; }
#ui-gear-panel { right: 10px; width: 270px; }
.ui-panel h3 {
  margin: 6px 6px 4px; font-size: 10px; font-weight: 600; letter-spacing: .15em;
  color: rgba(255, 120, 230, 0.8); text-transform: uppercase;
}
.ui-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 5px 8px; }
.ui-row label { flex: 1; cursor: pointer; }
.ui-row input[type=range] { width: 100px; accent-color: #f5c; }
.ui-row input[type=checkbox] { accent-color: #6ff; width: 15px; height: 15px; cursor: pointer; }
.ui-row output { width: 34px; text-align: right; color: #8ff; }
.ui-sep { height: 1px; margin: 6px 4px; background: rgba(120, 255, 255, 0.15); }
.ui-reset { margin: 4px 8px 4px; padding: 5px 10px; border-radius: 6px; cursor: pointer;
  background: none; border: 1px solid rgba(255, 120, 230, 0.5); color: #f9e; font: inherit; }
.ui-reset:hover { background: rgba(255, 120, 230, 0.12); }
.ui-city { padding: 2px 8px 6px; }
.ui-city-name { color: #cff; }
.ui-city a { color: #f9e; word-break: break-all; }
.ui-city .ui-reset { margin: 6px 6px 0 0; }
.ui-cities { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; padding: 2px 8px 8px; }
.ui-cities button {
  padding: 5px 6px; border-radius: 6px; cursor: pointer; text-align: left; font: inherit;
  background: none; border: 1px solid rgba(120, 255, 255, 0.25); color: #cfe;
}
.ui-cities button:hover { background: rgba(120, 255, 255, 0.1); }
.ui-cities button[aria-pressed=true] { color: #f9f; border-color: rgba(255, 120, 255, 0.7); }
`;

const CAMERA_NAMES = ['Chase', 'Cockpit', 'Skyline', 'Map'];
/** Cameras in the button/key cycle (Map is URL-only). */
const CYCLE = 3;

type NumKey = 'volume' | 'timeScale' | 'rain' | 'haze' | 'exposure';
type BoolKey =
  'paused' | 'sound' | 'hud' | 'ssr' | 'volumetrics' | 'taa' | 'details' | 'ao';

const SLIDERS: [NumKey, string, number, number, number][] = [
  ['volume', 'Volume', 0, 1, 0.05],
  ['timeScale', 'Flight speed', 0, 2, 0.05],
  ['rain', 'Rain', 0, 2, 0.05],
  ['haze', 'Haze', 0, 2.5, 0.05],
  ['exposure', 'Brightness', 0.4, 2, 0.05],
];
const TOGGLES: [BoolKey, string][][] = [
  [
    ['paused', 'Pause'],
    ['sound', 'Sound'],
    ['hud', 'Stats overlay'],
  ],
  [
    ['ssr', 'Reflections'],
    ['volumetrics', 'Light shafts'],
    ['taa', 'Anti-aliasing'],
    ['details', 'Facade detail'],
    ['ao', 'Ambient occlusion'],
  ],
];

export class Controls {
  private camBtn!: HTMLButtonElement;
  private toast!: HTMLElement;
  private toastTimer = 0;
  private inputs = new Map<keyof UiState, HTMLInputElement>();
  private outputs = new Map<keyof UiState, HTMLOutputElement>();
  private panels: [HTMLButtonElement, HTMLElement][] = [];

  constructor(
    readonly state: UiState,
    private readonly onChange: (key: keyof UiState) => void,
  ) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    // Camera button: each click cycles to the next camera.
    const camBtn = this.button('ui-cam-btn', 'Next camera (C)', CAMERA_ICON);
    camBtn.removeAttribute('aria-expanded');
    camBtn.addEventListener('click', e => {
      e.stopPropagation();
      this.closeAll();
      this.cycleCamera();
    });
    this.camBtn = camBtn;
    this.toast = document.createElement('div');
    this.toast.id = 'ui-toast';
    this.toast.setAttribute('role', 'status');
    document.body.appendChild(this.toast);

    // Theme button: switches to the next city theme (also T).
    this.themeBtn = this.button(
      'ui-theme-btn',
      'Next city theme (T)',
      GLOBE_ICON,
    );
    this.themeBtn.removeAttribute('aria-expanded');
    this.themeBtn.addEventListener('pointerdown', e => e.stopPropagation());
    this.themeBtn.addEventListener('click', e => {
      e.stopPropagation();
      this.closeAll();
      this.onThemeClick();
    });

    // Drive button: take the controls (also F).
    this.driveBtn = this.button(
      'ui-drive-btn',
      'Fly it yourself (F)',
      WHEEL_ICON,
    );
    this.driveBtn.removeAttribute('aria-expanded');
    this.driveBtn.addEventListener('pointerdown', e => e.stopPropagation());
    this.driveBtn.addEventListener('click', e => {
      e.stopPropagation();
      this.closeAll();
      this.onDriveClick();
    });

    // Sound button: shows whether sound is actually playing (it starts off
    // until a gesture unlocks audio); a click turns it on or off.
    this.soundBtn = this.button('ui-sound-btn', 'Sound on', SOUND_OFF_ICON);
    this.soundBtn.removeAttribute('aria-expanded');
    this.soundBtn.addEventListener('click', e => {
      e.stopPropagation();
      this.closeAll();
      this.onSoundClick();
    });
    this.updateSound(false);

    // Settings button + panel.
    const gearBtn = this.button('ui-gear-btn', 'Settings', GEAR_ICON);
    const gearPanel = this.panel('ui-gear-panel', 'Settings');
    const h = document.createElement('h3');
    h.textContent = 'Settings';
    gearPanel.appendChild(h);
    TOGGLES[0].forEach(t => gearPanel.appendChild(this.toggle(...t)));
    gearPanel.appendChild(this.sep());
    SLIDERS.forEach(s => gearPanel.appendChild(this.slider(...s)));
    gearPanel.appendChild(this.sep());
    const h2 = document.createElement('h3');
    h2.textContent = 'Graphics';
    gearPanel.appendChild(h2);
    TOGGLES[1].forEach(t => gearPanel.appendChild(this.toggle(...t)));
    const reset = document.createElement('button');
    reset.className = 'ui-reset';
    reset.textContent = 'Reset to defaults';
    reset.addEventListener('click', () => {
      for (const k of PERSIST) {
        (this.state as unknown as Record<string, unknown>)[k] = DEFAULTS[k];
        this.onChange(k);
      }
      this.refresh();
      save(this.state);
    });
    gearPanel.appendChild(reset);
    gearPanel.appendChild(this.sep());
    const hc = document.createElement('h3');
    hc.textContent = 'City';
    gearPanel.appendChild(hc);
    this.cityList = document.createElement('div');
    this.cityList.className = 'ui-cities';
    this.cityList.setAttribute('role', 'group');
    this.cityList.setAttribute('aria-label', 'City');
    gearPanel.appendChild(this.cityList);
    const h3 = document.createElement('h3');
    h3.textContent = 'This city';
    gearPanel.appendChild(h3);
    this.cityBox = document.createElement('div');
    this.cityBox.className = 'ui-city';
    gearPanel.appendChild(this.cityBox);

    this.panels = [[gearBtn, gearPanel]];
    for (const [btn, panel] of this.panels) {
      // Not 'elsewhere' for the close-on-pointerdown below, which would
      // close the panel just before this click reopened it.
      btn.addEventListener('pointerdown', e => e.stopPropagation());
      btn.addEventListener('click', e => {
        e.stopPropagation();
        this.toggleOpen(panel, Boolean(panel.hidden));
      });
      panel.addEventListener('pointerdown', e => e.stopPropagation());
    }
    // Close when clicking elsewhere or pressing Escape.
    window.addEventListener('pointerdown', () => this.closeAll());
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        this.closeAll();
        (document.activeElement as HTMLElement | null)?.blur();
      }
    });
    this.refresh();
  }

  private button(id: string, label: string, icon: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.id = id;
    b.className = 'ui-btn';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-expanded', 'false');
    b.innerHTML = icon;
    document.body.appendChild(b);
    return b;
  }

  private panel(id: string, label: string): HTMLElement {
    const p = document.createElement('div');
    p.id = id;
    p.className = 'ui-panel';
    p.hidden = true;
    p.setAttribute('role', 'menu');
    p.setAttribute('aria-label', label);
    document.body.appendChild(p);
    return p;
  }

  private sep(): HTMLElement {
    const d = document.createElement('div');
    d.className = 'ui-sep';
    return d;
  }

  private toggle(key: BoolKey, label: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'ui-row';
    const id = `ui-${key}`;
    const l = document.createElement('label');
    l.htmlFor = id;
    l.textContent = label;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.addEventListener('change', () => {
      this.state[key] = input.checked;
      save(this.state);
      this.onChange(key);
    });
    row.append(l, input);
    this.inputs.set(key, input);
    return row;
  }

  private slider(
    key: NumKey,
    label: string,
    min: number,
    max: number,
    step: number,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'ui-row';
    const id = `ui-${key}`;
    const l = document.createElement('label');
    l.htmlFor = id;
    l.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.id = id;
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    const out = document.createElement('output');
    input.addEventListener('input', () => {
      this.state[key] = Number(input.value);
      out.textContent = `${Math.round(this.state[key] * 100)}%`;
      save(this.state);
      this.onChange(key);
    });
    row.append(l, input, out);
    this.inputs.set(key, input);
    this.outputs.set(key, out);
    return row;
  }

  private toggleOpen(panel: HTMLElement, open: boolean) {
    for (const [b, p] of this.panels) {
      const o = p === panel && open;
      p.hidden = !o;
      b.setAttribute('aria-expanded', String(o));
    }
  }

  /** Switches to the next camera (chase, cockpit, skyline). The map view
   * is only reachable with ?cam=map. */
  cycleCamera() {
    this.state.camera = ((Math.min(this.state.camera, CYCLE - 1) + 1) %
      CYCLE) as CameraMode;
    this.state.shot = undefined;
    this.onChange('camera');
    this.showToast(`${CAMERA_NAMES[this.state.camera]} camera`);
  }

  /** Shows a toast; `sticky` keeps it up until the next showToast. */
  showToast(text: string, sticky = false) {
    this.toast.textContent = text;
    this.toast.classList.add('show');
    clearTimeout(this.toastTimer);
    if (sticky) return;
    this.toastTimer = window.setTimeout(
      () => this.toast.classList.remove('show'),
      1400,
    );
  }

  closeAll() {
    for (const [b, p] of this.panels) {
      p.hidden = true;
      b.setAttribute('aria-expanded', 'false');
    }
  }

  private cityBox!: HTMLElement;
  private cityList!: HTMLElement;

  /**
   * Lists the cities (themes) to pick from, `current` highlighted. Picking
   * one calls onCityPick (the globe button / T still cycle from there).
   */
  setCities(cities: {name: string; label: string}[], current: string) {
    this.cityList.replaceChildren(
      ...cities.map(c => {
        const b = document.createElement('button');
        b.textContent = c.label;
        b.dataset.city = c.name;
        b.setAttribute('aria-pressed', String(c.name === current));
        b.addEventListener('click', () => this.onCityPick(c.name));
        return b;
      }),
    );
  }

  /** Called with a city (theme) name picked in the settings. */
  onCityPick: (name: string) => void = () => {};

  /**
   * Shows the current city's theme and a link that reopens exactly this
   * city (the page URL itself is never changed, so a reload gives a new
   * city).
   */
  setCity(label: string, url: string) {
    this.cityBox.replaceChildren();
    const name = document.createElement('div');
    name.className = 'ui-city-name';
    name.textContent = label;
    const link = document.createElement('a');
    link.href = url;
    link.textContent = url.replace(/^https?:\/\//, '');
    link.id = 'ui-city-link';
    const copy = document.createElement('button');
    copy.className = 'ui-reset';
    copy.textContent = 'Copy link';
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(url).then(() => {
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy link'), 1500);
      });
    });
    this.cityBox.append(name, link, copy);
  }

  /** Called when the drive button is clicked. */
  onDriveClick: () => void = () => {};
  private driveBtn: HTMLButtonElement;

  /** Shows whether the user is flying the car. */
  setDriving(on: boolean) {
    this.driveBtn.classList.toggle('on', on);
    this.driveBtn.setAttribute('aria-pressed', String(on));
    const label = on ? 'Back to autopilot (F)' : 'Fly it yourself (F)';
    this.driveBtn.title = label;
    this.driveBtn.setAttribute('aria-label', label);
  }

  /** Called when the theme button is clicked (main.ts reloads). */
  onThemeClick: () => void = () => {};
  private themeBtn: HTMLButtonElement;

  /** Called when the sound button is clicked (main.ts toggles audio). */
  onSoundClick: () => void = () => {};
  private soundBtn: HTMLButtonElement;
  private soundShown: boolean | null = null;

  /** Shows the sound button as on (playing) or off. Cheap to call often. */
  updateSound(playing: boolean) {
    if (playing === this.soundShown) return;
    this.soundShown = playing;
    this.soundBtn.innerHTML = playing ? SOUND_ON_ICON : SOUND_OFF_ICON;
    this.soundBtn.classList.toggle('off', !playing);
    const label = playing ? 'Sound off' : 'Sound on';
    this.soundBtn.title = label;
    this.soundBtn.setAttribute('aria-label', label);
    this.soundBtn.setAttribute('aria-pressed', String(playing));
  }

  /** Syncs the controls with the state (call after keyboard changes). */
  refresh() {
    for (const [k, input] of this.inputs) {
      const v = this.state[k];
      if (typeof v === 'boolean') input.checked = v;
      else if (typeof v === 'number') {
        input.value = String(v);
        const out = this.outputs.get(k);
        if (out) out.textContent = `${Math.round(v * 100)}%`;
      }
    }
  }

  setVisible(v: boolean) {
    this.camBtn.style.display = v ? '' : 'none';
    this.soundBtn.style.display = v ? '' : 'none';
    this.themeBtn.style.display = v ? '' : 'none';
    this.driveBtn.style.display = v ? '' : 'none';
    for (const [b, p] of this.panels) {
      b.style.display = v ? '' : 'none';
      if (!v) p.hidden = true;
    }
  }
}
