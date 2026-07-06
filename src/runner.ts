import { Backend, NormalizedEvent, RunOptions } from './types';

export async function* runTurn(backend: Backend, options: RunOptions): AsyncIterable<NormalizedEvent> {
  yield* backend.run(options);
}
