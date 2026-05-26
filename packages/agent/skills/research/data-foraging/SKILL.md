---
name: data-foraging
description: Systematic methodology for discovering, evaluating, and acquiring datasets and statistical data for research and analysis tasks. Use this skill whenever the user needs to find datasets, locate authoritative statistics, source training data, find benchmark datasets, evaluate data quality, or triangulate conflicting numerical claims. Trigger on phrases like "find a dataset for", "where can I get data on", "what data exists for", "I need statistics about", "find me benchmark data", "source data for my model", or any research task where finding the right data is the blocking problem. Also trigger when the user mentions specific data portals, asks about data quality, or needs to validate a statistic they've encountered.
allowed-tools: [web_search, browser, web_extract]
---

# Data Foraging

Finding the right data is often harder than analyzing it. Most searches surface aggregated statistics or derivative datasets far removed from primary measurement. This skill encodes the methodology for finding data that is authoritative, appropriate in scope, and honestly understood.

## Core Principle: Data Provenance First

Before using any dataset, you must know:
1. **Who collected it** and what their methodology was
2. **When** it was collected (temporal validity)
3. **What population / geography / domain** it covers
4. **What it actually measures** (not just what it's called)

A statistic without provenance is a rumor with a decimal point.

---

## Phase 1: Define the Data Need

Before searching, clarify what you actually need. Vague data needs produce irrelevant results.

### Data specification questions

Ask (and answer) these before issuing any queries:

| Dimension | Questions to answer |
|-----------|---------------------|
| **Domain** | What phenomenon is being measured? (precipitation, GDP, user behavior, protein structure?) |
| **Geography** | Global? Country? Region? Grid-cell level? |
| **Temporal** | Historical archive? Near-real-time? Specific period? |
| **Resolution** | Daily/hourly/annual? Point measurements? Raster? Tabular? |
| **Format** | CSV/NetCDF/HDF5/JSON/API? What can your pipeline consume? |
| **License** | Can it be used commercially? Published in research? Redistributed? |
| **Size** | What scale can your infrastructure handle? |

**Red flag**: If you can't answer most of these questions, you need to iterate with the user before searching.

---

## Phase 2: Source Hierarchy

Not all data portals are equal. Search in this order:

### Tier 1 — Primary Measurement / Official Statistics

These produce the data themselves; no intermediary processing.

**Earth & Environmental Sciences** (highly relevant for Duya's user base):
- NOAA National Centers for Environmental Information (`ncei.noaa.gov`) — climate, weather, ocean
- NASA Earthdata (`earthdata.nasa.gov`) — satellite, remote sensing, atmospheric
- Copernicus Climate Data Store (`cds.climate.copernicus.eu`) — ERA5 reanalysis, global coverage
- USGS National Water Information System (`waterdata.usgs.gov`) — streamflow, groundwater
- China Meteorological Administration data portals — CMA SURF, CMFD
- ECMWF open data — NWP model output, reanalysis
- GPM / TRMM (NASA) — satellite precipitation
- GLEAM, MODIS, SMAP — land surface and soil moisture

**Economics & Social Science**:
- World Bank Open Data (`data.worldbank.org`)
- IMF Data (`imf.org/en/Data`)
- OECD.Stat (`stats.oecd.org`)
- UN Data (`data.un.org`)
- National statistics offices (e.g., NBS China, BLS USA, Eurostat)

**Health & Biology**:
- WHO Global Health Observatory
- CDC Wonder
- GBD (Global Burden of Disease) data
- NCBI databases (GenBank, GEO, SRA)

**Machine Learning Benchmarks**:
- Papers With Code (`paperswithcode.com/datasets`) — ML datasets with leaderboards
- HuggingFace Datasets Hub (`huggingface.co/datasets`)
- OpenML (`openml.org`)
- UC Irvine ML Repository

### Tier 2 — Curated Aggregators

These compile from primary sources with quality control:
- Kaggle Datasets — varied quality; check dataset votes and author credibility
- Google Dataset Search (`datasetsearch.research.google.com`)
- Zenodo — academic research datasets, DOI-linked
- Figshare — research data repository
- Harvard Dataverse

### Tier 3 — Derived / Processed

Use only when Tier 1/2 don't have what you need:
- GitHub repositories containing processed datasets (check original source)
- Supplementary data files attached to papers
- Data scraped and shared by third parties

---

## Phase 3: Search Strategy

### Query patterns for data discovery

Standard search queries surface portals, not the specific dataset. Use these patterns:

```
[phenomenon] dataset [temporal range] [geography]
[variable name] open data download
[domain] benchmark dataset [task type]
[variable] NetCDF / CSV download research
site:earthdata.nasa.gov [variable]
site:kaggle.com [domain] dataset
"data availability" [phenomenon] [journal name]
```

**Vocabulary tip**: Use the technical variable name, not the lay term. "Precipitation" → also try "rainfall", "PRCP", "precipitation rate", "QPE" (quantitative precipitation estimation). Each term will surface different datasets.

### Finding datasets attached to papers

Many of the best datasets are released alongside papers:

1. Search Google Scholar for `[topic] dataset release 2022` or `[topic] benchmark dataset`
2. In the paper, look for a "Data Availability Statement" section
3. Check the paper's supplementary materials
4. Check if authors have a lab/group page listing released datasets

**Papers With Code** is particularly effective here — it links papers directly to their datasets and code.

---

## Phase 4: Dataset Evaluation

Once you find candidate datasets, evaluate them before committing.

### Evaluation checklist

**Provenance**
- [ ] Is the original data collection methodology documented?
- [ ] Is there a data descriptor paper or technical report?
- [ ] Who funded the data collection?

**Coverage & Representativeness**
- [ ] Does the geographic/temporal coverage match the need?
- [ ] Are there known gaps or missing periods?
- [ ] Is the sampling design appropriate (random? systematic? convenience?)

**Quality**
- [ ] What quality control procedures were applied?
- [ ] Is there a quality flag variable?
- [ ] What are the known error sources and their magnitudes?
- [ ] Has this dataset been validated against independent measurements?

**Freshness**
- [ ] When was this version released?
- [ ] Is it still actively maintained?
- [ ] Is there a newer version or successor dataset?

**License & Terms of Use**
- [ ] What license applies? (CC0, CC-BY, CC-BY-NC, custom?)
- [ ] Are there restrictions on commercial use, redistribution, or publication?
- [ ] Is attribution required?

### Comparing competing datasets

When multiple datasets measure the same thing, create a comparison:

| Attribute | Dataset A | Dataset B |
|-----------|-----------|-----------|
| Resolution | | |
| Coverage period | | |
| Methodology | | |
| Validation status | | |
| License | | |
| Last updated | | |
| Actively maintained | | |

This prevents cargo-culting (using a dataset "because everyone uses it") and surfaces trade-offs explicitly.

---

## Phase 5: Statistical Claim Verification

When you encounter a specific statistic in the wild and need to verify it:

### Tracing a claim back to source

1. Find the original publication where the number first appeared
2. Check whether that publication clearly states methodology
3. Verify the number hasn't been misquoted or stripped of important caveats (e.g., "X in population Y, in year Z" → becomes "X" everywhere)

### When statistics conflict

Common causes of conflicting numbers for the "same" quantity:

| Cause | Example |
|-------|---------|
| Different measurement methodology | Remote sensing vs. in-situ gauge precipitation |
| Different geographic scope | National average vs. specific region |
| Different time period | Annual vs. peak season |
| Different definition | Headline unemployment vs. U-6 unemployment |
| Different base population | All adults vs. employed adults |

Resolution approach: don't pick one number and ignore the other. Document both, explain the likely source of divergence, and recommend the measure most appropriate for the specific use case.

---

## Phase 6: Data Access & Download

### Access patterns

| Access type | When to use | Tools |
|-------------|-------------|-------|
| Direct download (CSV/ZIP) | Small files, one-time use | Browser, wget, curl |
| API | Programmatic, parameterized queries | requests, relevant SDK |
| OPeNDAP/THREDDS | NetCDF remote subsetting | xarray, pydap |
| Cloud-native (S3/GCS) | Large-scale analysis | boto3, gcsfs, zarr |
| FTP/SFTP | Legacy scientific archives | lftp, filezilla |

### For large or programmatic access

Always check if the dataset has:
- An official Python/R client library
- An example Jupyter notebook in the documentation
- A community-maintained wrapper (e.g., `xarray` backends for climate data)

Starting from an official example is faster than reverse-engineering the API from documentation alone.

---

## Output Format

When presenting data foraging results to the user, structure the output as:

```
## Dataset Recommendation: [Task Description]

### Best Match: [Dataset Name]
- Source: [Organization + URL]
- Coverage: [geography, time period, resolution]
- Format: [file format, size estimate]
- License: [license type + key restrictions]
- Access: [how to download / API endpoint]
- Caveats: [known limitations, quality issues]
- Citation: [recommended citation or DOI]

### Alternatives Considered
- [Dataset B]: [why it's second choice]
- [Dataset C]: [why it's third choice or ruled out]

### Unresolved Questions
- [Anything that needs clarification before the user can proceed]
```

If no suitable dataset exists, say so explicitly and suggest alternative approaches (proxy variables, synthetic data generation, manual collection, collaboration with data holders).