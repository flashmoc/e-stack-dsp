'use strict';
const express=require('express');
const state=require('../public/prototypes/estack-ui/shared/domain/input-eq-state');
const {revision}=require('./advancedModel');
module.exports=(app,system)=>{
  app.post('/api/input-processing',express.json({limit:'1mb'}),async(req,res)=>{
    try {
      const {scope,before,next}=req.body||{};
      if(!['geq','peq','delay'].includes(scope)||!before||!next) throw new Error('Invalid scoped input processing proposal.');
      const result=await system.editProcessing(revision(before),live=>{
        state.assertMutation(live,next,scope);
        return next;
      });
      res.json(result);
    } catch(error) {res.status(409).json({error:error.message});}
  });
};
