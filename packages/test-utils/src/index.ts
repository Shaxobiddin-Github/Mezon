export const TEST_UTILS_PACKAGE = '@mezon/test-utils';

export { FixedClock, SequenceClock } from './fake-clock.js';
export { FixedRandomSource, SequenceRandomSource, SeededRandomSource } from './fake-random.js';
export {
  DeterministicUuidV7Generator,
  type DeterministicUuidV7GeneratorOptions,
  FixedIdGenerator,
} from './fake-id-generator.js';
