/**
 * how the engine shows a task: the JSON view of a stored row and the
 * evidence artifact rendered from a release
 */
import { randomUUID } from 'node:crypto';

import { renderEvidenceParts } from '../widgets';

import { EVIDENCE_ARTIFACT_ID } from './engine-types';
import { taskView } from './view';

import type { DisclosureResult } from '../contracts';

import type { EngineDeps } from './engine-types';
import type { TaskRow } from './task-store';
import type { ArtifactJson, Shown, TaskJson } from './view';

/**
 * shows a stored task, optionally overriding its state, parts, time or artifacts
 * @param task the stored task
 * @param shown what to show instead of the stored status
 * @returns the task as JSON, with a fresh status message id
 */
export function view(task: TaskRow, shown?: Partial<Shown>): TaskJson {
  return taskView(
    task,
    {
      state: shown?.state ?? task.status.state,
      parts: shown?.parts ?? task.status.parts ?? [],
      timestamp: shown?.timestamp ?? task.status.timestamp,
      artifacts: shown?.artifacts,
    },
    randomUUID(),
  );
}

/**
 * renders the evidence artifact for a release
 * @param deps the source-file lookup and part links
 * @param task the released task
 * @param result what the pipeline released
 * @returns the one evidence artifact
 */
export function evidence(
  deps: EngineDeps,
  task: TaskRow,
  result: DisclosureResult,
): ArtifactJson[] {
  const recordIds = new Set(result.evidence.map((item) => item.recordId));

  return [
    {
      artifactId: EVIDENCE_ARTIFACT_ID,
      name: 'Medissy selective evidence (SYNTHETIC DEMO)',
      parts: renderEvidenceParts({
        result,
        sourceFileIds: deps.sourceFiles(task.patientId, recordIds),
        links: deps.links,
      }),
    },
  ];
}
