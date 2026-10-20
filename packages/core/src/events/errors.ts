/** An event the platform refuses to publish: an unknown module or event, a module that is not enabled, a bad payload. */
export class EventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventError";
  }
}
