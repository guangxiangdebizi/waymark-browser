const internal = /^(?:https?|wss?|about|blob|data|file|filesystem|javascript|chrome(?:-extension|-untrusted)?|devtools|view-source):/i;

export function externalTarget(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (!internal.test(parsed.protocol)) return parsed.href;
  } catch { /* Relative or invalid URLs cannot name an external handler. */ }
  return undefined;
}

/** One instance per tab. Permission callbacks alone do not identify who initiated a navigation. */
export class ExternalNavigation {
  private lastInput = -Infinity;
  private pending?: { url: string; expires: number };

  constructor(private readonly now = () => performance.now()) {}

  input(type: string): void {
    if (/^(mouseUp|keyDown|rawKeyDown|touchEnd|gestureTap)$/.test(type)) this.lastInput = this.now();
  }

  navigation(url: string, direct: boolean): void {
    const target = externalTarget(url);
    const expires = (direct ? this.now() : this.lastInput) + 5000;
    this.pending = target && this.now() < expires ? { url: target, expires } : undefined;
  }

  consume(url: string, handlerName: (url: string) => string): boolean {
    const permit = this.pending;
    if (!permit || permit.url !== externalTarget(url)) return false;
    this.pending = undefined;
    if (this.now() >= permit.expires) return false;
    try { return Boolean(handlerName(url)); } catch { return false; }
  }
}
