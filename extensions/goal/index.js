// mina /goal entry point: pi-goal (pinned, unmodified) with mina's checks and research phase. The logic is in
// mina-goal.mjs, so tests can run it without loading pi-goal's TypeScript build.
import piGoal from '../../node_modules/@narumitw/pi-goal/dist/index.ts';
import { createMinaGoal } from './mina-goal.mjs';

export default function minaGoal(pi) {
  createMinaGoal(pi, { goalExtension: piGoal });
}
