import type { BackendCapabilities } from '../types';

export function canBindTaskToBackend(caps: BackendCapabilities | undefined): boolean {
  return caps?.supportsMCP === true;
}