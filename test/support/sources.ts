/**
 * JSX sources compiled by the tests (through `load`). The same source is compiled once for the
 * server (`ssr`) and once for the browser (`dom`), so markup and hydration keys agree.
 *
 * Imports are relative to the generated file, which lives in `test/.generated/`.
 */

/** A component that shows a query's status, its size, and the explicit cache key it uses. */
export const TASK_SUMMARY_SRC = `
import { useQuery } from "../../src/index";
export const TaskSummary = (props) => {
  const tasks = useQuery(props.list, props.args, { key: "tasks" });
  return <p class="tasks">{tasks.status}:{tasks() === undefined ? "none" : tasks().length}</p>;
};
`;
