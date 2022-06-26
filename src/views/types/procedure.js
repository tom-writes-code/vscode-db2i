
const Procedure = require(`../../database/callable`);
const ParmTreeItem = require(`./ParmTreeItem`);

const icons = {
  IN: `arrow-left`,
  OUT: `arrow-right`,
  INOUT: `arrow-both`,
}

exports.getChildren = async (schema, name) => {
  const columns = await Procedure.getParms(schema, name);

  return columns.map(column => new ParmTreeItem(schema, name, column));
}