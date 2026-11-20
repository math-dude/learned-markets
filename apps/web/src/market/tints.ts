const TINTS = ['#2C2528', '#26262B', '#2D2A24', '#26282E', '#2B2925', '#23272B', '#25282C']
export const tintFor = (i: number) => TINTS[i % TINTS.length]
