/** A job request the platform refuses: an unknown module or job, a module that is not enabled, a bad payload or option. */
export class JobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobError";
  }
}
