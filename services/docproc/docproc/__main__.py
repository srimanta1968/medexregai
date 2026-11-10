"""python -m docproc  (dev: DOCPROC_API_KEY=... python -m docproc)"""

import logging
import os

import uvicorn

from .app import create_app

if __name__ == '__main__':
    logging.basicConfig(level=os.environ.get('LOG_LEVEL', 'INFO').upper(), format='%(asctime)s %(levelname)s %(name)s %(message)s')
    uvicorn.run(create_app(), host=os.environ.get('DOCPROC_HOST', '127.0.0.1'), port=int(os.environ.get('DOCPROC_PORT', '4200')), log_level='warning')
