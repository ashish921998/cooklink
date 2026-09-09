// Reanimated 4 runs its animation code on the UI thread, which requires the
// worklets Babel plugin. It must stay last in the plugin list.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-worklets/plugin'],
  };
};
