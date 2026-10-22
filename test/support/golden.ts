/**
 * Server output of `TaskSummary` (see `sources.ts`) rendered with `renderToStringAsync` for two
 * tasks. `server.golden.server.test.ts` re-renders it and must reproduce this exactly; the DOM test
 * hydrates it. Keeping both in one place means the two halves cannot drift apart silently.
 */
export const TASK_SUMMARY_GOLDEN: {
  readonly html: string;
  readonly data: Record<string, unknown>;
} = {
  html: '<p data-hk="0-0-0" class="tasks"><!--[-->success<!--]-->:<!--[-->2<!--]--></p>',
  data: {
    "k:tasks": [
      { _id: "1", title: "task 1", done: false },
      { _id: "2", title: "task 2", done: false },
    ],
  },
};
