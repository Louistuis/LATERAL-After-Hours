import { SaveValidationError } from '../save/envelope';

/** Player-safe recovery copy. Never echo arbitrary storage, asset or SDK error text. */
export function describeBootFailure(error: unknown): { title: string; message: string } {
  if (error instanceof SaveValidationError) {
    if (error.code === 'future-version') return {
      title: 'Your save needs a newer game version.',
      message: 'Open the newer version of LATERAL that created this save. Your stored progress has been kept.',
    };
    if (error.code === 'oversized') return {
      title: 'This save is too large to open.',
      message: 'Use the version that created this save, or restore a smaller backup. Your stored progress has been kept.',
    };
    if (error.code === 'incompatible') return {
      title: 'This save is not compatible.',
      message: 'Use the game version that created this save, or restore a compatible backup. Your stored progress has been kept.',
    };
    return {
      title: 'This save could not be read.',
      message: 'The stored save is damaged or incomplete. Keep a copy before restoring a known-good backup. It has not been replaced.',
    };
  }
  if (error instanceof Error && /webgl|graphics/i.test(error.message)) return {
    title: 'The driving view could not start.',
    message: 'Check that your browser has hardware acceleration enabled, then reload the game.',
  };
  return { title: 'A little further to go.', message: 'The game could not finish loading. Reload to try again.' };
}
