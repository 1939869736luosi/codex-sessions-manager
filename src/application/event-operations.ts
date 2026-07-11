import {
  readCanonicalSessionEventPage,
  resolveExactSessionEventSource,
  streamCanonicalSessionEvents,
  writeCanonicalSessionEventsFile,
  type CanonicalSessionEvent,
  type CanonicalSessionEventFileResult,
  type CanonicalSessionEventPage,
} from "../core/session-events.js";

export interface SessionEventsInput {
  root?: string;
  sessionId: string;
}

export async function* streamSessionEventsOperation(
  input: SessionEventsInput,
): AsyncGenerator<CanonicalSessionEvent> {
  const source = await resolveExactSessionEventSource(input.root, input.sessionId);
  yield* streamCanonicalSessionEvents(source);
}

export async function writeSessionEventsOperation(
  input: SessionEventsInput & { outputPath: string },
): Promise<CanonicalSessionEventFileResult> {
  const source = await resolveExactSessionEventSource(input.root, input.sessionId);
  return writeCanonicalSessionEventsFile(source, input.outputPath);
}

export async function getSessionEventsPageOperation(
  input: SessionEventsInput & { limit?: number; cursor?: string },
): Promise<CanonicalSessionEventPage> {
  const source = await resolveExactSessionEventSource(input.root, input.sessionId);
  return readCanonicalSessionEventPage({
    ...source,
    limit: input.limit,
    cursor: input.cursor,
  });
}
