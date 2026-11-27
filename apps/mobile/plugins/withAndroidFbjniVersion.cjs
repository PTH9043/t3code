const { withProjectBuildGradle } = require("expo/config-plugins");

// Match React Native's NDK 27 runtime when a dependency requests fbjni:+.
const FBJNI_VERSION = "0.7.0";
const MARKER = "// T3 React Native fbjni runtime compatibility";
const BLOCK = `${MARKER}
allprojects {
  configurations.configureEach {
    resolutionStrategy.force 'com.facebook.fbjni:fbjni:${FBJNI_VERSION}'
  }
}
`;

function addFbjniVersionPin(contents) {
  return contents.includes(MARKER) ? contents : `${contents.trimEnd()}\n\n${BLOCK}`;
}

module.exports = function withAndroidFbjniVersion(config) {
  return withProjectBuildGradle(config, (nextConfig) => {
    if (nextConfig.modResults.language !== "groovy") {
      throw new Error(
        "The Android fbjni compatibility setting requires a Groovy project build file.",
      );
    }
    nextConfig.modResults.contents = addFbjniVersionPin(nextConfig.modResults.contents);
    return nextConfig;
  });
};
module.exports.addFbjniVersionPin = addFbjniVersionPin;
module.exports.FBJNI_VERSION = FBJNI_VERSION;
