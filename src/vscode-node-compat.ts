/**
 * VS Code Insiders currently exposes `globalThis.navigator` through a migration
 * getter that throws when legacy extension code reads it. Zod v4 reads the
 * global while MCP SDK modules initialize, before Muster can start its bridge.
 * Replace only that configurable compatibility getter with an inert value before
 * importing the MCP SDK graph; Node-only behavior does not rely on navigator.
 */
const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

if (descriptor?.get && descriptor.configurable) {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    enumerable: descriptor.enumerable ?? false,
    writable: true,
    value: undefined,
  });
}

