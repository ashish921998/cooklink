# Cooklink store screenshots

English (`en-US`) launch gallery built from the app's local design-preview fixtures and real iOS Simulator UI.

## Upload sets

- `ios-6.7/en-US/`: six opaque RGB PNGs at 1290 × 2796 px.
- `android-phone/en-US/`: six opaque RGB PNGs at 1080 × 1920 px (9:16).
- `android-phone/en-US/feature-graphic-1024x500.png`: Google Play feature graphic.

## Gallery order

1. Plan every meal together
2. Keep your cook in the loop
3. Turn every plan into groceries
4. Seven days. One clear plan.
5. Recipes your cook can follow
6. Choose exact packs, then order

The first three cover the core value, the cook/household differentiator, and the meal-plan-to-grocery outcome.

## Rebuild

With the Cooklink iOS app running in design-preview mode on a booted simulator:

```sh
maestro test artifacts/store-screenshots/capture-flow.yaml
maestro test artifacts/store-screenshots/capture-order-flow.yaml
maestro test artifacts/store-screenshots/capture-chat-flow.yaml
node artifacts/store-screenshots/compose.mjs
```

The final assets are deterministic; generated imagery is not used for the in-app UI.
