import { expect, test } from "bun:test";
import { allowedPage, answerFor } from "../extension/matching.mjs";
test("prefill requires a supported page and an exact known answer", () => {
  expect(allowedPage("https://www.upwork.com/apply")).toBe(false);
  expect(allowedPage("https://upwork.com/apply")).toBe(false);
  expect(allowedPage("chrome://settings")).toBe(false);
  expect(allowedPage("https://jobs.example.com/apply")).toBe(true);
  const draft = { proposal: "Known proposal", answers: [{ question: "Describe your integration experience", answer: "Known answer" }, { question: "Work authorization", answer: "Should not be filled" }] };
  expect(answerFor("Describe your integration experience?", draft)).toBe("Known answer");
  expect(answerFor("Cover letter", draft)).toBe("Known proposal");
  expect(answerFor("Work authorization", draft)).toBeNull();
  expect(answerFor("Unrecognized question", draft)).toBeNull();
});
