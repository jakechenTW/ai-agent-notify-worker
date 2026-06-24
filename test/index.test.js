import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

test("non-POST requests return 405", async () => {
  const response = await worker.fetch(
    new Request("https://notify.example.test", { method: "GET" }),
    {},
    {}
  );

  assert.equal(response.status, 405);
  assert.equal(await response.text(), "Method Not Allowed");
});
