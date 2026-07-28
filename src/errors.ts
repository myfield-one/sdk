// Public error classes. Exported unprefixed — the @myfield/sdk package
// scope is the namespace; `error.name` matches the class name.

export class NotConnectedError extends Error {
  constructor() {
    super("bucket is not connected; call connect() first");
    this.name = "NotConnectedError";
  }
}
