#!/bin/bash
set -e
cd /home/z/my-project
PYTHONUNBUFFERED=1 python3 pipeline/master_pipeline.py \
  --input-dir /home/z/my-project/data/jobs/cms3i6vr7000inqsfu71cv169/dataset \
  --output /home/z/my-project/data/jobs/cms3i6vr7000inqsfu71cv169/output/master_recap.mp4 \
  --work-dir /home/z/my-project/data/jobs/cms3i6vr7000inqsfu71cv169/work \
  --voice en-US-AndrewNeural \
  --narration-provider none \
  --skip-captions \
  --no-translate \
  > /home/z/my-project/pipeline_run.log 2>&1
echo "EXIT_CODE=$?" >> /home/z/my-project/pipeline_run.log
