module.exports = function htmlLoader(source) {
  return `export default ${JSON.stringify(source)};`;
};
