# Legacy hardware templates

These files come from the original CamillaNode installation flow and are **not used** by the E-Stack `setup.sh` or `pi-update.sh` scripts.

They are kept temporarily only to avoid silently breaking an existing Raspberry installation that may still reference one of these paths. Do not use the old CamillaDSP service/YAML templates as a source of truth for the current E-Stack hardware.

The canonical E-Stack DSP service installation is owned by `scripts/pi-install.sh`.
`camillanode.service` in this folder remains a legacy reference for rollback and
is not installed. Normal updates never modify CamillaDSP, ALSA or the live DSP YAML.
