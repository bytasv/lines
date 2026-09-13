/** Private development-supervisor channel. Inert in production and ordinary tests. */
export const DEV_UPDATING = 'Updating local runtime. Please retry shortly.';
export interface DevActivity {
  ready: boolean;
  blockers: string[];
  relayConnected?: boolean;
}

export class DevRuntime {
  readonly enabled: boolean;
  held: boolean;
  private operations = 0;
  private activity: () => DevActivity = () => ({ ready: false, blockers: ['starting'] });
  private activated: (() => void)[] = [];
  private status: unknown = null;

  constructor(enabled = process.env.LINES_DEV_SUPERVISED === '1' && !!process.send) {
    this.enabled = enabled;
    this.held = enabled;
    if (!enabled) return;
    process.on('message', (message: any) => {
      if (message?.type !== 'devControl') return;
      let ok = true;
      if (message.action === 'prepare') {
        const state = this.snapshot();
        ok = state.ready && state.blockers.length === 0;
        if (ok) this.held = true;
      } else if (message.action === 'activate') {
        this.activate();
      } else if (message.action === 'status') {
        this.status = message.status;
      } else return;
      if (process.connected) process.send?.({ type: 'devAck', id: message.id, ok, ...this.snapshot() }, () => {});
    });
    const timer = setInterval(() => this.report(), 250);
    timer.unref();
    // A lost supervisor must never kill an agent. Fail closed for future reloads.
    process.on('disconnect', () => this.activate());
  }

  activate() {
    this.held = false;
    for (const callback of this.activated.splice(0)) callback();
  }

  configure(activity: () => DevActivity) { this.activity = activity; }
  snapshot(): DevActivity {
    const state = this.activity();
    return { ...state, blockers: [...state.blockers, ...(this.operations ? ['requests in flight'] : []), ...(this.activated.length ? ['deferred worker messages'] : [])] };
  }
  report() {
    if (this.enabled && process.connected) process.send?.({ type: 'devActivity', ...this.snapshot() }, () => {});
  }
  whenActive(callback: () => void) {
    if (this.held) { this.activated.push(callback); this.report(); }
    else callback();
  }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.held) throw new Error(DEV_UPDATING);
    this.operations++;
    try { return await operation(); }
    finally { this.operations--; this.report(); }
  }
  get publicStatus() { return this.enabled ? this.status : undefined; }
}
export const devRuntime = new DevRuntime();
