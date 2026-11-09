import assert from "node:assert/strict";
import { test } from "node:test";
import {
  headersBefore,
  itemTop,
  rowAtY,
  rowTop,
  sectionRowsFor,
  totalGridHeight,
} from "../src/virtualGridGeometry.ts";

const geometry = {
  count: 10,
  cols: 2,
  rowHeight: 110,
  itemHeight: 100,
  headerHeight: 40,
  sections: [0, 4, 7],
  sectionRows: [0, 2, 3],
};

test("section item indexes collapse to grid rows", () => {
  assert.deepEqual(sectionRowsFor(10, 2, [0, 4, 7, 7]), [0, 2, 3]);
  assert.deepEqual(sectionRowsFor(10, 1, [2, 5]), [2, 5]);
  assert.deepEqual(sectionRowsFor(3, 2, [8]), []);
});

test("heading prefix counts and row offsets are exact", () => {
  assert.equal(headersBefore(geometry.sectionRows, 0), 0);
  assert.equal(headersBefore(geometry.sectionRows, 1), 1);
  assert.equal(headersBefore(geometry.sectionRows, 3), 2);
  assert.equal(headersBefore(geometry.sectionRows, 5), 3);
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((row) => rowTop(geometry, row)),
    [0, 150, 260, 410, 560],
  );
  assert.equal(itemTop(geometry, 0), 40);
  assert.equal(itemTop(geometry, 3), 150);
  assert.equal(itemTop(geometry, 4), 300);
  assert.equal(itemTop(geometry, 7), 450);
});

test("total height and inverse row lookup include headings", () => {
  assert.equal(totalGridHeight(geometry, 10), 660);
  assert.equal(rowAtY(geometry, 0), 0);
  assert.equal(rowAtY(geometry, 39), 0);
  assert.equal(rowAtY(geometry, 40), 0);
  assert.equal(rowAtY(geometry, 109), 0);
  assert.equal(rowAtY(geometry, 149), 0);
  assert.equal(rowAtY(geometry, 150), 1);
  assert.equal(rowAtY(geometry, 259), 1);
  assert.equal(rowAtY(geometry, 260), 2);
  assert.equal(rowAtY(geometry, 659), 4);
});

test("no sections keeps the original deterministic grid geometry", () => {
  const plain = {
    ...geometry,
    sections: [],
    sectionRows: [],
    headerHeight: 0,
  };
  assert.equal(totalGridHeight(plain, 10), 5 * 110 - 10);
  assert.equal(rowTop(plain, 3), 330);
  assert.equal(itemTop(plain, 7), 330);
});
