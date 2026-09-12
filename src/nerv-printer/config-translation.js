'use strict'

function translatePoint(point, delta) {
  if (!point || !delta) return point
  return {
    x: Number(point.x) + delta.x,
    y: Number(point.y) + delta.y,
    z: Number(point.z) + delta.z
  }
}

function translateMachineSpot(spot, delta) {
  const translated = translatePoint(spot, delta)
  const accessPosition = translatePoint(spot?.accessPosition, delta)
  return accessPosition ? { ...translated, accessPosition } : translated
}

function translateMachineNodes(nodes, delta) {
  if (!Array.isArray(nodes)) return []
  return nodes.map((node) => ({
    ...node,
    position: translatePoint(node?.position, delta),
    accessPosition: translatePoint(node?.accessPosition, delta)
  }))
}

module.exports = {
  translateMachineNodes,
  translateMachineSpot,
  translatePoint
}
