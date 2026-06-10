import { armHangDiag } from './hang-diag';

// Vitest globalSetup — runs in the MAIN vitest process, the one GitHub kills
// ("Terminate orphan process … npm run test:unit"). If it's the main process
// that refuses to exit, this is where the leaked handle shows up.
export default function setup(): void {
	armHangDiag('MAIN');
}
