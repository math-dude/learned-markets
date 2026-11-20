# Codama Python renderer templates

Copied from https://github.com/Solana-ZH/codama-py/tree/7521566cac44ed9a5d152a144951c5fef9e65e16/public/templates
(tag `v0.1.7-beta`). The upstream MIT license is included.

The npm artifact `codama-py@0.1.7-beta` ships its renderer bundle but omits these
templates. The Python generation script points Nunjucks at this exact snapshot
and disables HTML escaping for Python source. It uses isolated Codama converter
versions and pins the renderer's original render-map API. Generated Python
wire tests run against SBF-produced account and instruction fixtures.
