// Built-in swatch palettes shown in the Color panel. Colours are `#rrggbb`.

export interface Palette {
  id: PaletteId;
  name: string;
  colors: readonly string[];
}

export type PaletteId = 'fluent' | 'material' | 'pastel' | 'neon' | 'earth' | 'grayscale';

export const PALETTES: readonly Palette[] = [
  {
    id: 'fluent',
    name: 'Fluent',
    // Fluent UI shared colours.
    colors: [
      '#750b1c', '#c50f1f', '#d13438', '#da3b01', '#f7630c', '#ff8c00',
      '#eaa300', '#fde300', '#c19c00', '#8e562e', '#498205', '#0b6a0b',
      '#00cc6a', '#00b7c3', '#038387', '#005b70', '#0078d4', '#004e8c',
      '#4f6bed', '#7160e8', '#5c2e91', '#881798', '#e43ba6', '#69797e',
    ],
  },
  {
    id: 'material',
    name: 'Material',
    // Material Design 2014 palette, 500 shades, plus black and white.
    colors: [
      '#f44336', '#e91e63', '#9c27b0', '#673ab7', '#3f51b5', '#2196f3',
      '#03a9f4', '#00bcd4', '#009688', '#4caf50', '#8bc34a', '#cddc39',
      '#ffeb3b', '#ffc107', '#ff9800', '#ff5722', '#795548', '#9e9e9e',
      '#607d8b', '#000000', '#ffffff',
    ],
  },
  {
    id: 'pastel',
    name: 'Pastel',
    colors: [
      '#ffadad', '#ffd6a5', '#fdffb6', '#caffbf', '#9bf6ff', '#a0c4ff',
      '#bdb2ff', '#ffc6ff', '#f1c0e8', '#cfbaf0', '#a3c4f3', '#90dbf4',
      '#8eecf5', '#98f5e1', '#b9fbc0', '#fbf8cc', '#fde4cf', '#ffcfd2',
      '#fffffc', '#e2ece9',
    ],
  },
  {
    id: 'neon',
    name: 'Neon',
    colors: [
      '#ff00ff', '#ff1493', '#fe1c80', '#ff073a', '#ff5f1f', '#ff9900',
      '#f5d300', '#ccff00', '#39ff14', '#0fff50', '#00ff9f', '#09fbd3',
      '#00ffff', '#08f7fe', '#01cdfe', '#7df9ff', '#1f51ff', '#b026ff',
      '#bc13fe', '#fe53bb',
    ],
  },
  {
    id: 'earth',
    name: 'Earth',
    colors: [
      '#3e2723', '#5d4037', '#6b4226', '#8b4513', '#a0522d', '#b7410e',
      '#cd853f', '#e2725b', '#c19a6b', '#d2b48c', '#deb887', '#e1c699',
      '#c2b280', '#8f9779', '#808000', '#6b8e23', '#556b2f', '#4a5d23',
      '#2e4d3a', '#708090', '#4e5b5e', '#a1887f',
    ],
  },
  {
    id: 'grayscale',
    name: 'Grayscale',
    colors: [
      '#000000', '#111111', '#222222', '#333333', '#444444', '#555555',
      '#666666', '#777777', '#888888', '#999999', '#aaaaaa', '#bbbbbb',
      '#cccccc', '#dddddd', '#eeeeee', '#ffffff',
    ],
  },
];

export function getPalette(id: PaletteId): Palette {
  const p = PALETTES.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown palette ${id}`);
  return p;
}
