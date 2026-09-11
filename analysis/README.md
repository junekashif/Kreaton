# analysis

Offline statistics sidecar. Nothing here is imported by the engine or the console.

- `crosscheck.py` reproduces the fitter and the evaluation from an exported feature table using NumPy,
  SciPy and scikit-learn, and compares against `data/model.json`: weight-of-evidence tables, fitted
  weights, fused scores, ROC AUC, KS, Brier, average precision, and an independent isotonic
  calibration. Run `npm run seed -- --export` first.
- `sensitivity.py` perturbs each default policy estimate and reports how far the closed-form decision
  boundaries move, writing `docs/SENSITIVITY.md`.

```bash
pip install -r requirements.txt
python analysis/crosscheck.py
python analysis/sensitivity.py
```
