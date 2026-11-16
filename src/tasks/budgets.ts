import type { TaskOptions } from './schemas.ts';

/** Reserve bootstrap instructions within the initial prompt/context character cap. */
export function taskPromptCapacity(options:Pick<TaskOptions,'maxContextChars'>):number {
  return (options.maxContextChars??32000)-1000;
}
