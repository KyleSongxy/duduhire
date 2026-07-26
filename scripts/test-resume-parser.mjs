import assert from 'node:assert/strict';
import {
  extractTextFromRtf,
  getResumeFormat,
  readResumeFile,
  ResumeImportError,
} from '../js/resume-parser.js';

assert.equal(getResumeFormat({ name: 'resume.PDF', type: '' }), 'pdf');
assert.equal(getResumeFormat({
  name: 'resume',
  type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}), 'docx');

assert.throws(
  () => getResumeFormat({ name: 'resume.doc', type: 'application/msword' }),
  (error) => error instanceof ResumeImportError && error.code === 'LEGACY_WORD',
);

const rtf = String.raw`{\rtf1\ansi\ansicpg936\uc0 \u24352 \u26195 \u26126 \par AI \u20135 \u21697 \u32463 \u29702 }`;
assert.equal(extractTextFromRtf(rtf), '张晓明\nAI 产品经理');

const textResult = await readResumeFile({
  name: 'resume.txt',
  type: 'text/plain',
  size: 36,
  text: async () => '负责 AI 产品上线并完成验收。',
});
assert.deepEqual(textResult, {
  format: 'txt',
  text: '负责 AI 产品上线并完成验收。',
});

await assert.rejects(
  () => readResumeFile({
    name: 'empty.md',
    type: 'text/markdown',
    size: 1,
    text: async () => ' ',
  }),
  (error) => error instanceof ResumeImportError && error.code === 'NO_TEXT',
);

console.log('Resume parser validation tests passed.');
