/**
 * the A2A 1.0 Task a caller sees, in ProtoJSON form (no `kind`
 * discriminators); built from the stored task plus what this poll decided to
 * show; engine bookkeeping (`metadata`, the caller binding, the receipt and
 * the origin message id) is never included
 */
import type { TaskState } from '../contracts';

import type { StoredPart, TaskRow } from './task-store';

/** an agent message in JSON form */
export interface MessageJson {
  messageId: string;
  role: 'ROLE_AGENT';
  taskId: string;
  contextId: string;
  parts: StoredPart[];
}

/** an artifact in JSON form */
export interface ArtifactJson {
  artifactId: string;
  name: string;
  parts: StoredPart[];
}

/** a task in JSON form */
export interface TaskJson {
  id: string;
  contextId: string;
  status: { state: TaskState; message: MessageJson; timestamp: string };
  artifacts: ArtifactJson[];
  history: MessageJson[];
}

/** what a poll shows */
export interface Shown {
  state: TaskState;
  parts: StoredPart[];
  timestamp: string;
  artifacts?: ArtifactJson[];
}

/**
 * builds the caller's view of a task
 * @param task the stored task
 * @param shown the state, status parts and artifacts this poll shows
 * @param messageId the status message id
 * @returns the task JSON
 */
export function taskView(
  task: TaskRow,
  shown: Shown,
  messageId: string,
): TaskJson {
  return {
    id: task.id,
    contextId: task.contextId,
    status: {
      state: shown.state,
      message: {
        messageId,
        role: 'ROLE_AGENT',
        taskId: task.id,
        contextId: task.contextId,
        parts: shown.parts,
      },
      timestamp: shown.timestamp,
    },
    artifacts: shown.artifacts ?? [],
    history: [],
  };
}
