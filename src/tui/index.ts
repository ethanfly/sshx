import { TuiApp, TuiOptions } from './app.js';

export type { TuiOptions } from './app.js';

export async function startTUI(options: TuiOptions = {}): Promise<void> {
  const app = new TuiApp(options);
  await app.start();
}
