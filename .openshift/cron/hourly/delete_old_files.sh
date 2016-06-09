#!/bin/sh
find $OPENSHIFT_DATA_DIR/.teleirc/files/ ! -path $OPENSHIFT_DATA_DIR/.teleirc/files/ -mmin +1440 -delete 