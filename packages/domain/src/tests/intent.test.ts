import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectIntent, roleForGroceryIntent } from '../intent.js';

test('Hindi grocery line with item yields a grocery_request intent', () => {
  const i = detectIntent('नारियल चाहिए');
  assert.equal(i.kind, 'grocery_request');
  if (i.kind === 'grocery_request') {
    assert.equal(i.item, 'नारियल');
  }
});

test('bare "I need grocery" leaves the item empty so Chat asks what is needed', () => {
  const i = detectIntent('I need grocery');
  assert.equal(i.kind, 'grocery_request');
  if (i.kind === 'grocery_request') assert.equal(i.item, '');
});

test('meal change intent captures meal type', () => {
  const i = detectIntent('change dinner to paneer');
  assert.equal(i.kind, 'meal_change');
  if (i.kind === 'meal_change') assert.equal(i.mealType, 'dinner');
});

test('irrelevant text is unknown (no private action is created)', () => {
  assert.equal(detectIntent('see you tomorrow').kind, 'unknown');
});

test('cook creates a grocery_request; member gets add_to_cart for the same intent', () => {
  assert.equal(roleForGroceryIntent('cook'), 'grocery_request');
  assert.equal(roleForGroceryIntent('member'), 'add_to_cart');
  assert.equal(roleForGroceryIntent('owner'), 'add_to_cart');
});
