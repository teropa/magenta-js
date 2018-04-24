
/**
 * @license
 * Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
import * as tf from '@tensorflow/tfjs';
import {isNullOrUndefined} from 'util';

import {INoteSequence, NoteSequence} from '../protobuf/index';

import * as sequences from './sequences';

export const DEFAULT_DRUM_PITCH_CLASSES: number[][] = [
  // bass drum
  [36, 35],
  // snare drum
  [38, 27, 28, 31, 32, 33, 34, 37, 39, 40, 56, 65, 66, 75, 85],
  // closed hi-hat
  [42, 44, 54, 68, 69, 70, 71, 73, 78, 80],
  // open hi-hat
  [46, 67, 72, 74, 79, 81],
  // low tom
  [45, 29, 41, 61, 64, 84],
  // mid tom
  [48, 47, 60, 63, 77, 86, 87],
  // high tom
  [50, 30, 43, 62, 76, 83],
  // crash cymbal
  [49, 55, 57, 58],
  // ride cymbal
  [51, 52, 53, 59, 82]
];

export interface MelodyConverterSpec {
  type: 'MelodyConverter';
  args: MelodyConverterArgs;
}
export interface DrumsConverterSpec {
  type: 'DrumsConverter';
  args: DrumsConverterArgs;
}
export interface DrumRollConverterSpec {
  type: 'DrumRollConverter';
  args: DrumsConverterArgs;
}
export interface TrioConverterSpec {
  type: 'TrioConverter';
  args: TrioConverterArgs;
}
export interface DrumsOneHotConverterSpec {
  type: 'DrumsOneHotConverter';
  args: DrumsConverterArgs;
}

/**
 * Interface for JSON specification of a `DataConverter`.
 *
 * @property type The name of the `DataConverter` class.
 * @property args Map containing values for argments to the constructor of the
 * `DataConverter` class specified above.
 */
export type ConverterSpec = MelodyConverterSpec|DrumsConverterSpec|
    DrumRollConverterSpec|TrioConverterSpec|DrumsOneHotConverterSpec;

/**
 * Builds a `DataConverter` based on the given `ConverterSpec`.
 *
 * @param spec Specifies the `DataConverter` to build.
 * @returns A new `DataConverter` object based on `spec`.
 */
export function converterFromSpec(spec: ConverterSpec): DataConverter {
  switch (spec.type) {
    case 'MelodyConverter':
      return new MelodyConverter(spec.args);
    case 'DrumsConverter':
      return new DrumsConverter(spec.args);
    case 'DrumRollConverter':
      return new DrumRollConverter(spec.args);
    case 'TrioConverter':
      return new TrioConverter(spec.args);
    case 'DrumsOneHotConverter':
      return new DrumsOneHotConverter(spec.args);
    default:
      throw new Error(`Unknown DataConverter type: ${spec}`);
  }
}

/**
 * Constructor arguments shared by all `DataConverter`s.
 *
 * @param numSteps The length of each sequence.
 * @param numSegments (Optional) The number of conductor segments, if
 * applicable.
 */
export interface BaseConverterArgs {
  numSteps?: number;
  numSegments?: number;
}

/**
 * Abstract DataConverter class for converting between `Tensor` and
 * `NoteSequence` objects.
 */
export abstract class DataConverter {
  readonly numSteps: number;             // Total length of sequences.
  readonly numSegments: number;          // Number of steps for conductor.
  abstract readonly depth: number;       // Size of final output dimension.
  abstract readonly NUM_SPLITS: number;  // Const number of conductor splits.
  abstract toTensor(noteSequence: INoteSequence): tf.Tensor2D;
  abstract async toNoteSequence(tensor: tf.Tensor2D): Promise<INoteSequence>;

  constructor(args: BaseConverterArgs) {
    this.numSteps = args.numSteps;
    this.numSegments = args.numSegments;
  }
}

/**
 * Converts between a quantized `NoteSequence` containing a drum sequence
 * and the `Tensor` objects used by `MusicVAE`.
 *
 * The `Tensor` output by `toTensor` is a 2D "drum roll" format. Each
 * row is a time step, and each column (up to the final) is a vector of Booleans
 * representing whether a drum from the associated pitch class is being hit at
 * that time. The final column is a Boolean computed by taking a NOR of the
 * other columns in the row.
 *
 * The expected `Tensor` in `toNoteSequence` is a one-hot encoding of labels
 * generated by converting the bit string from the input (excluding the final
 * bit) to an integer.
 *
 * The output `NoteSequence` uses quantized time and only the first pitch in
 * pitch class are used.
 *
 * @param numSteps The length of each sequence.
 * @param numSegments (Optional) The number of conductor segments, if
 * applicable.
 * @param pitchClasses (Optional) An array of arrays, grouping together MIDI
 * pitches to treat as the same drum. The first pitch in each class will be used
 * in the `NoteSequence` returned by `toNoteSequence`. A default mapping to 9
 * classes is used if not provided.
 */
export interface DrumsConverterArgs extends BaseConverterArgs {
  pitchClasses?: number[][];
}
export class DrumsConverter extends DataConverter {
  readonly pitchClasses: number[][];
  readonly pitchToClass: Map<number, number>;
  readonly NUM_SPLITS = 0;  // const
  depth: number;

  constructor(args: DrumsConverterArgs) {
    super(args);
    this.pitchClasses = isNullOrUndefined(args.pitchClasses) ?
        DEFAULT_DRUM_PITCH_CLASSES :
        args.pitchClasses;
    this.pitchToClass = new Map<number, number>();
    for (let c = 0; c < this.pitchClasses.length; ++c) {  // class
      this.pitchClasses[c].forEach((p) => {
        this.pitchToClass.set(p, c);
      });
    }
    this.depth = this.pitchClasses.length;
  }

  toTensor(noteSequence: INoteSequence) {
    const numSteps = this.numSteps || noteSequence.totalQuantizedSteps;
    const drumRoll = tf.buffer([numSteps, this.pitchClasses.length + 1]);
    // Set final values to 1 and change to 0 later if the column gets a note.
    for (let i = 0; i < numSteps; ++i) {
      drumRoll.set(1, i, -1);
    }
    noteSequence.notes.forEach((note) => {
      drumRoll.set(
          1, note.quantizedStartStep, this.pitchToClass.get(note.pitch));
      drumRoll.set(0, note.quantizedStartStep, -1);
    });
    return drumRoll.toTensor() as tf.Tensor2D;
  }

  async toNoteSequence(oh: tf.Tensor2D) {
    const noteSequence = NoteSequence.create();
    const labelsTensor = oh.argMax(1);
    const labels: Int32Array = await labelsTensor.data() as Int32Array;
    labelsTensor.dispose();
    for (let s = 0; s < labels.length; ++s) {               // step
      for (let p = 0; p < this.pitchClasses.length; p++) {  // pitch class
        if (labels[s] >> p & 1) {
          noteSequence.notes.push(NoteSequence.Note.create({
            pitch: this.pitchClasses[p][0],
            quantizedStartStep: s,
            quantizedEndStep: s + 1,
            isDrum: true
          }));
        }
      }
    }
    return noteSequence;
  }
}

/**
 * Converts between a quantized `NoteSequence` containing a drum sequence
 * and the `Tensor` objects used by `MusicVAE`.
 *
 * The `Tensor` output by `toTensor` is the same 2D "drum roll" as in
 * `DrumsConverter`.
 *
 * The expected `Tensor` in `toNoteSequence` is the same as the "drum roll",
 * excluding the final NOR column.
 *
 * The output `NoteSequence` uses quantized time and only the first pitch in
 * pitch class are used.
 */
export class DrumRollConverter extends DrumsConverter {
  async toNoteSequence(roll: tf.Tensor2D) {
    const noteSequence = NoteSequence.create();
    const rollSplit = tf.split(roll, roll.shape[0]);
    for (let s = 0; s < roll.shape[0]; ++s) {  // step
      const pitches = await rollSplit[s].data() as Uint8Array;
      rollSplit[s].dispose();
      for (let p = 0; p < pitches.length; ++p) {  // pitch class
        if (pitches[p]) {
          noteSequence.notes.push(NoteSequence.Note.create({
            pitch: this.pitchClasses[p][0],
            quantizedStartStep: s,
            quantizedEndStep: s + 1,
            isDrum: true
          }));
        }
      }
    }
    return noteSequence;
  }
}

/**
 * Converts between a quantized `NoteSequence` containing a drum sequence
 * and the `Tensor` objects used by `MusicRNN`.
 *
 * The `Tensor` output by `toTensor` is a 2D one-hot encoding. Each
 * row is a time step, and each column is a one-hot vector where each drum
 * combination is mapped to a single bit of a binary integer representation,
 * where the bit has value 0 if the drum combination is not present, and 1 if
 * it is present.
 *
 * The expected `Tensor` in `toNoteSequence` is the same kind of one-hot
 * encoding as the `Tensor` output by `toTensor`.
 *
 * The output `NoteSequence` uses quantized time and only the first pitch in
 * pitch class are used.
 *
 */
export class DrumsOneHotConverter extends DrumsConverter {
  readonly depth: number;

  constructor(args: DrumsConverterArgs) {
    super(args);
    this.depth = Math.pow(2, this.pitchClasses.length);
  }

  toTensor(noteSequence: INoteSequence) {
    const numSteps = this.numSteps || noteSequence.totalQuantizedSteps;
    const labels = Array<number>(numSteps).fill(0);
    for (const {pitch, quantizedStartStep} of noteSequence.notes) {
      labels[quantizedStartStep] += Math.pow(2, this.pitchToClass.get(pitch));
    }
    return tf.tidy(() => tf.oneHot(tf.tensor1d(labels, 'int32'), this.depth));
  }
}

/**
 * Converts between a monophonic, quantized `NoteSequence` containing a melody
 * and the `Tensor` objects used by `MusicVAE`.
 *
 * Melodies are represented as a sequence of categorical variables, representing
 * one of three possible events:
 *   - A non-event, i.e. holding a note or resting. (0)
 *   - A note off. (1)
 *   - A note on with a specific pitch. (> 1)
 *
 * The `Tensor` output by `toTensor` is a one-hot encoding of the sequence of
 * labels extracted from the `NoteSequence`.
 *
 * The expected `Tensor` in `toNoteSequence` is a one-hot encoding of melody
 * sequence labels like those returned by `toTensor`.
 *
 * @param numSteps The length of each sequence.
 * @param minPitch The minimum pitch to model. Those above this value will
 * cause an errot to be thrown.
 * @param maxPitch The maximum pitch to model. Those above this value will
 * cause an error to be thrown.
 * @param numSegments (Optional) The number of conductor segments, if
 * applicable.
 */
export interface MelodyConverterArgs extends BaseConverterArgs {
  minPitch: number;
  maxPitch: number;
}
export class MelodyConverter extends DataConverter {
  readonly minPitch: number;  // inclusive
  readonly maxPitch: number;  // inclusive
  readonly depth: number;
  readonly NUM_SPLITS = 0;   // const
  readonly NOTE_OFF = 1;     // const
  readonly FIRST_PITCH = 2;  // const

  constructor(args: MelodyConverterArgs) {
    super(args);
    this.minPitch = args.minPitch;
    this.maxPitch = args.maxPitch;
    this.depth = args.maxPitch - args.minPitch + 1 + this.FIRST_PITCH;
  }

  toTensor(noteSequence: INoteSequence) {
    const numSteps = this.numSteps || noteSequence.totalQuantizedSteps;
    const sortedNotes: NoteSequence.INote[] = noteSequence.notes.sort(
        (n1, n2) => n1.quantizedStartStep - n2.quantizedStartStep);
    const mel = tf.buffer([numSteps], 'int32');
    let lastEnd = -1;
    sortedNotes.forEach(n => {
      if (n.quantizedStartStep < lastEnd) {
        throw new Error('`NoteSequence` is not monophonic.');
      }
      if (n.pitch < this.minPitch || n.pitch > this.maxPitch) {
        throw Error(
            '`NoteSequence` has a pitch outside of the valid range: ' +
            `${n.pitch}`);
      }
      mel.set(n.pitch - this.minPitch + this.FIRST_PITCH, n.quantizedStartStep);
      mel.set(this.NOTE_OFF, n.quantizedEndStep);
      lastEnd = n.quantizedEndStep;
    });
    return tf.tidy(() => tf.oneHot(mel.toTensor() as tf.Tensor1D, this.depth));
  }

  async toNoteSequence(oh: tf.Tensor2D) {
    const noteSequence = NoteSequence.create();
    const labelsTensor = oh.argMax(1);
    const labels: Int32Array = await labelsTensor.data() as Int32Array;
    labelsTensor.dispose();
    let currNote: NoteSequence.Note = null;
    for (let s = 0; s < labels.length; ++s) {  // step
      const label = labels[s];
      switch (label) {
        case 0:
          break;
        case 1:
          if (currNote) {
            currNote.quantizedEndStep = s;
            noteSequence.notes.push(currNote);
            currNote = null;
          }
          break;
        default:
          if (currNote) {
            currNote.quantizedEndStep = s;
            noteSequence.notes.push(currNote);
          }
          currNote = NoteSequence.Note.create({
            pitch: label - this.FIRST_PITCH + this.minPitch,
            quantizedStartStep: s
          });
      }
    }
    if (currNote) {
      currNote.quantizedEndStep = labels.length;
      noteSequence.notes.push(currNote);
    }
    return noteSequence;
  }
}

export interface TrioConverterArgs extends BaseConverterArgs {
  melArgs: MelodyConverterArgs;
  bassArgs: MelodyConverterArgs;
  drumsArgs: DrumsConverterArgs;
}
export class TrioConverter extends DataConverter {
  melConverter: MelodyConverter;
  bassConverter: MelodyConverter;
  drumsConverter: DrumsConverter;
  readonly depth: number;
  readonly NUM_SPLITS = 3;              // const
  readonly MEL_PROG_RANGE = [0, 31];    // inclusive, const
  readonly BASS_PROG_RANGE = [32, 39];  // inclusive, const

  constructor(args: TrioConverterArgs) {
    super(args);
    // Copy numSteps to all converters.
    args.melArgs.numSteps = args.numSteps;
    args.bassArgs.numSteps = args.numSteps;
    args.drumsArgs.numSteps = args.numSteps;
    this.melConverter = new MelodyConverter(args.melArgs);
    this.bassConverter = new MelodyConverter(args.bassArgs);
    this.drumsConverter = new DrumsOneHotConverter(args.drumsArgs);
    this.depth =
        (this.melConverter.depth + this.bassConverter.depth +
         this.drumsConverter.depth);
  }

  toTensor(noteSequence: INoteSequence) {
    const melSeq = sequences.clone(noteSequence);
    const bassSeq = sequences.clone(noteSequence);
    const drumsSeq = sequences.clone(noteSequence);
    melSeq.notes = noteSequence.notes.filter(
        n =>
            (!n.isDrum && n.program >= this.MEL_PROG_RANGE[0] &&
             n.program <= this.MEL_PROG_RANGE[1]));
    bassSeq.notes = noteSequence.notes.filter(
        n =>
            (!n.isDrum && n.program >= this.BASS_PROG_RANGE[0] &&
             n.program <= this.BASS_PROG_RANGE[1]));
    drumsSeq.notes = noteSequence.notes.filter(n => n.isDrum);
    return tf.tidy(
        () => tf.concat(
            [
              this.melConverter.toTensor(melSeq),
              this.bassConverter.toTensor(bassSeq),
              this.drumsConverter.toTensor(drumsSeq)
            ],
            -1));
  }

  async toNoteSequence(th: tf.Tensor2D) {
    const ohs = tf.split(
        th,
        [
          this.melConverter.depth, this.bassConverter.depth,
          this.drumsConverter.depth
        ],
        -1);
    const ns = await this.melConverter.toNoteSequence(ohs[0] as tf.Tensor2D);

    ns.notes.forEach(n => {
      n.instrument = 0;
      n.program = 0;
    });
    const bassNs =
        await this.bassConverter.toNoteSequence(ohs[1] as tf.Tensor2D);
    ns.notes.push(...bassNs.notes.map(n => {
      n.instrument = 1;
      n.program = this.BASS_PROG_RANGE[0];
      return n;
    }));
    const drumsNs =
        await this.drumsConverter.toNoteSequence(ohs[2] as tf.Tensor2D);
    ns.notes.push(...drumsNs.notes.map(n => {
      n.instrument = 2;
      return n;
    }));
    ohs.forEach(oh => oh.dispose());
    return ns;
  }
}
