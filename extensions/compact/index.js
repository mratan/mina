import hotCompact from '../../node_modules/pi-hot-compact/index.ts';
import { createMinaCompact } from './mina-compact.mjs';

export default function minaCompact(pi) {
  createMinaCompact(pi, { hotCompact });
}
