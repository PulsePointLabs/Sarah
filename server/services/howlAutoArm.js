export function isRuntimeAutoArmValid(savedSettings, runtimeArmToken) {
  return Boolean(
    savedSettings?.sarahAutoEnabled
    && savedSettings?.runtimeArmToken
    && savedSettings.runtimeArmToken === runtimeArmToken,
  );
}
