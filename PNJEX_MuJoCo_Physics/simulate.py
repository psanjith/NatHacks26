"""Force-driven, released-object 100 g grasp experiments; no pose forcing after init."""
from pathlib import Path
import argparse, json, time, hashlib, math
import copy
from dataclasses import dataclass, asdict
from functools import lru_cache
import numpy as np
import mujoco
from tendon_forces import tendon_cable_forces

HERE=Path(__file__).resolve().parent
OUT=HERE.parents[1]/'outputs/PNJEX_MuJoCo_Physics' if HERE.name=='mujoco_physics' else HERE
ARM=['yaw_joint','shoulder_joint','elbow_joint','wrist_joint']

@lru_cache(maxsize=4)
def _cached_model(resolved_path,mtime_ns,size):
    """Cache only the pristine compiled model; callers always receive a copy."""
    return mujoco.MjModel.from_xml_path(resolved_path)

@dataclass
class Parameters:
    name: str='baseline'
    dt: float=.0005
    friction: float=.5
    arm_cap_Nm: float=1.5
    micro_cap_Nm: float=.06
    cable_stiffness_N_m: float=1500
    cable_damping_Ns_m: float=.1
    cable_slack_m: float=.001
    spring_scale: float=1.
    preload_delta_deg: float=0.
    finger_damping_Nms: float=.0003
    finger_frictionloss_Nm: float=0.
    spool_armature_kgm2: float=.000001
    contact_timeconst_s: float=.006
    contact_dampratio: float=1.
    wind_angle_rad: float=1.6
    arm_kp: float=50.
    arm_kd: float=.6
    spool_kp: float=.4
    spool_kd: float=.0015
    gravity_compensation: bool=True
    release_s: float=2.5
    lift_start_s: float=3.
    lift_end_s: float=5.
    end_s: float=8.
    close_start_s: float=.3
    close_end_s: float=2.2
    disturb_N: float=0.

def ids(model,names,kind=mujoco.mjtObj.mjOBJ_JOINT):
    return np.array([mujoco.mj_name2id(model,kind,n) for n in names],dtype=int)

def smooth(t,start,end):
    s=float(np.clip((t-start)/(end-start),0,1))
    return 10*s**3-15*s**4+6*s**5

def smooth_rate(t,start,end):
    if t<=start or t>=end:return 0.
    s=(t-start)/(end-start)
    return (30*s**2-60*s**3+30*s**4)/(end-start)

def run_case(model_path, params=None, record=False, viewer=False, render_callback=None):
    params=params or Parameters()
    if params.finger_frictionloss_Nm<0:
        raise ValueError('Finger dry-friction scenario must be nonnegative')
    model_path=Path(model_path)
    model_stat=model_path.stat()
    model=copy.copy(_cached_model(str(model_path.resolve()),model_stat.st_mtime_ns,model_stat.st_size))
    modelmeta=json.loads(model_path.with_suffix('.json').read_text(encoding='utf-8'))
    data=mujoco.MjData(model)
    model.opt.timestep=params.dt
    if np.linalg.norm(model.opt.gravity)<9 or model.opt.disableflags&int(mujoco.mjtDisableBit.mjDSBL_CONTACT):
        raise ValueError('Gravity and collision must be enabled')
    armids=ids(model,ARM)
    spoolids=ids(model,[f'finger_{i}_spool_joint' for i in range(1,4)])
    fingerids=ids(model,[f'finger_{i}_{seg}_joint' for i in range(1,4) for seg in ['proximal','distal']])
    aq=model.jnt_qposadr[armids];ad=model.jnt_dofadr[armids]
    sq=model.jnt_qposadr[spoolids];sd=model.jnt_dofadr[spoolids]
    fq=model.jnt_qposadr[fingerids]
    motorids=ids(model,['drive_'+n for n in ARM]+[f'drive_spool_{i}' for i in range(1,4)],mujoco.mjtObj.mjOBJ_ACTUATOR)
    tids=ids(model,[f'finger_{i}_tendon_reference' for i in range(1,4)],mujoco.mjtObj.mjOBJ_TENDON)
    objectid=int(ids(model,['object'],mujoco.mjtObj.mjOBJ_GEOM)[0])
    objectbody=int(ids(model,['payload'],mujoco.mjtObj.mjOBJ_BODY)[0])
    objectjoint=int(ids(model,['payload_free'])[0])
    if model.jnt_type[objectjoint]!=mujoco.mjtJoint.mjJNT_FREE:
        raise ValueError('Payload must have its own unconstrained free joint after holder release')
    object_dofs=slice(int(model.jnt_dofadr[objectjoint]),int(model.jnt_dofadr[objectjoint])+6)
    palmid=int(ids(model,['wrist_palm'],mujoco.mjtObj.mjOBJ_BODY)[0])
    fixture=int(ids(model,['initial_holder'],mujoco.mjtObj.mjOBJ_EQUALITY)[0])
    gripper_parts={'23_Root_Fork','24_Proximal_Finger','25_Distal_Finger','26_Proximal_Soft_Pad','27_Distal_Soft_Pad','21_Compact_Palm'}
    allowed=set();pads=set();fingergeomsets=[set() for _ in range(3)];palm_geoms=set()
    for n,entry in modelmeta['collision_geoms'].items():
        gid=mujoco.mj_name2id(model,mujoco.mjtObj.mjOBJ_GEOM,n)
        if gid<0:continue
        if entry['part'] in gripper_parts:allowed.add(gid)
        if entry['pad']:
            pads.add(gid)
            model.geom_friction[gid]=[params.friction,.0001,.0001]
        if entry['part']=='21_Compact_Palm':palm_geoms.add(gid)
        for i in range(3):
            if entry['body'].startswith(f'finger_{i+1}_') and entry['part'] in gripper_parts:fingergeomsets[i].add(gid)
        model.geom_solref[gid]=[params.contact_timeconst_s,params.contact_dampratio]
    model.geom_friction[objectid]=[min(params.friction,.25),.0001,.0001]
    model.geom_solref[objectid]=[params.contact_timeconst_s,params.contact_dampratio]
    for i,jid in enumerate(fingerids):
        proximal=i%2==0
        model.jnt_stiffness[jid]=params.spring_scale*(.005 if proximal else .0222)
        model.qpos_spring[model.jnt_qposadr[jid]]=-np.radians((21.8492 if proximal else 19.2466)+params.preload_delta_deg)
        model.dof_damping[model.jnt_dofadr[jid]]=params.finger_damping_Nms
        model.dof_frictionloss[model.jnt_dofadr[jid]]=params.finger_frictionloss_Nm
    model.dof_armature[sd]=params.spool_armature_kgm2
    mujoco.mj_setConst(model,data)
    mujoco.mj_resetData(model,data)
    data.eq_active[fixture]=True
    mujoco.mj_forward(model,data)
    Lfree=data.ten_length[tids].copy()+params.cable_slack_m
    target_final=np.radians([0,20,5,-15])
    initial_object_pos=data.xpos[objectbody].copy()
    initial_object_rotation=data.xmat[objectbody].reshape(3,3).copy()
    initial_object_penetration=0.;initial_placement_contacts=[]
    for con in data.contact[:data.ncon]:
        a,b=int(con.geom1),int(con.geom2)
        if objectid in (a,b):
            depth=max(0.,-float(con.dist));initial_object_penetration=max(initial_object_penetration,depth)
            if depth>0:
                other=b if a==objectid else a
                initial_placement_contacts.append({'geom':mujoco.mj_id2name(model,mujoco.mjtObj.mjOBJ_GEOM,other),'penetration_mm':depth*1000})
    ref_local=None;release_object_z=None;release_time=None;release_twist=None
    fixture_max_position_deviation=0.;fixture_max_orientation_deviation=0.
    release_position_deviation=None;release_orientation_deviation=None
    peak_tension=np.zeros(3);peak_arm=np.zeros(4);peak_micro=np.zeros(3)
    post_peak_tension=np.zeros(3);post_peak_arm=np.zeros(4);post_peak_micro=np.zeros(3)
    peak_error=np.zeros(4);sat_arm=np.zeros(4);sat_micro=np.zeros(3)
    hold_samples=0;max_penetration=0.;max_all_object_penetration=initial_object_penetration;max_self_penetration=0.;bad_contacts=set()
    max_slip=0.;max_energy_residual=0.;max_omega_spool=np.zeros(3)
    post_max_omega_spool=np.zeros(3);post_max_energy_residual=0.
    max_object_direct_qfrc=np.zeros(6)
    geometry_observations=0;completed_hold_duration=0.;completed_steps=0
    limited_joints=np.array([j for j in range(model.njnt)
        if model.jnt_type[j]==mujoco.mjtJoint.mjJNT_HINGE and model.jnt_limited[j]],dtype=int)
    limited_qpos=model.jnt_qposadr[limited_joints]
    limit_lower_peak=np.zeros(len(limited_joints));limit_upper_peak=np.zeros(len(limited_joints))
    hold_z=[];hold_rel=[];held_contact_samples=0;finger_contact_counts=np.zeros(3)
    two_finger_samples=0;pad_contact_samples=0;hold_vertical_contact=[]
    postrelease_palm_contact=False;released_eq_reenabled=False
    invalid=False;invalid_reason='';traces=[];physical_records=[]

    def orientation_deviation():
        R=data.xmat[objectbody].reshape(3,3)
        return float(np.arccos(np.clip((np.trace(initial_object_rotation.T@R)-1)/2,-1,1)))

    def observe_joint_limits():
        nonlocal limit_lower_peak,limit_upper_peak
        q=data.qpos[limited_qpos]
        limit_lower_peak=np.maximum(limit_lower_peak,np.maximum(model.jnt_range[limited_joints,0]-q,0))
        limit_upper_peak=np.maximum(limit_upper_peak,np.maximum(q-model.jnt_range[limited_joints,1],0))

    def observe_geometry(t,count_hold=True):
        # This runs at EVERY integration-step state, not at the CSV cadence.
        # The final integrated endpoint is also checked without adding duration.
        nonlocal max_penetration,max_all_object_penetration,max_self_penetration,postrelease_palm_contact,max_slip
        nonlocal hold_samples,held_contact_samples,two_finger_samples,pad_contact_samples
        nonlocal fixture_max_position_deviation,fixture_max_orientation_deviation,geometry_observations
        geometry_observations+=1
        rel=data.xmat[palmid].reshape(3,3).T@(data.xpos[objectbody]-data.xpos[palmid])
        if ref_local is None:
            fixture_max_position_deviation=max(fixture_max_position_deviation,float(np.linalg.norm(data.xpos[objectbody]-initial_object_pos)))
            fixture_max_orientation_deviation=max(fixture_max_orientation_deviation,orientation_deviation())
        objcontacts=[];selfcontacts=[];normal_indices=[]
        for idx in range(data.ncon):
            con=data.contact[idx];a=int(con.geom1);b=int(con.geom2)
            if objectid in (a,b):
                other=b if a==objectid else a
                objcontacts.append(other);normal_indices.append(idx)
                max_all_object_penetration=max(max_all_object_penetration,max(0,-con.dist))
                if ref_local is not None:
                    max_penetration=max(max_penetration,max(0,-con.dist))
                    if other not in allowed:bad_contacts.add(mujoco.mj_id2name(model,mujoco.mjtObj.mjOBJ_GEOM,other))
                    if other in palm_geoms:postrelease_palm_contact=True
            elif model.geom_contype[a]==4 and model.geom_contype[b]==4:
                selfcontacts.append((a,b))
                max_self_penetration=max(max_self_penetration,max(0,-con.dist))
        if ref_local is not None:
            max_slip=max(max_slip,float(np.linalg.norm(rel-ref_local)))
        if t+1e-9>=params.lift_end_s and ref_local is not None:
            hold_z.append(float(data.xpos[objectbody,2]));hold_rel.append(rel.copy())
            if count_hold:
                hold_samples+=1
                present=set(objcontacts)
                held_contact_samples+=bool(present&allowed)
                two_finger_samples+=sum(bool(present&gs) for gs in fingergeomsets)>=2
                pad_contact_samples+=bool(present&pads)
                for i,gs in enumerate(fingergeomsets):finger_contact_counts[i]+=bool(present&gs)
        return rel,objcontacts,selfcontacts,normal_indices

    observe_joint_limits()
    launch=None
    if viewer:
        from mujoco import viewer as mjviewer
        launch=mjviewer.launch_passive(model,data,show_left_ui=False,show_right_ui=False)
        launch.cam.lookat[:]=[.10,-.02,.12];launch.cam.distance=.65;launch.cam.azimuth=135;launch.cam.elevation=-20
        launch.opt.geomgroup[3:]=0
        if not modelmeta.get('visuals_included',True):launch.opt.geomgroup[0]=1
    count=int(np.ceil(params.end_s/params.dt));startwall=time.monotonic();sample_stride=max(1,round(.01/params.dt));record_stride=max(1,round(.04/params.dt))
    for step in range(count):
        t=float(data.time)
        if t+1e-9>=params.release_s:
            if ref_local is None:
                mujoco.mj_forward(model,data)
                ref_local=data.xmat[palmid].reshape(3,3).T@(data.xpos[objectbody]-data.xpos[palmid])
                release_object_z=float(data.xpos[objectbody,2])
                release_time=t
                release_twist=np.zeros(6)
                mujoco.mj_objectVelocity(model,data,mujoco.mjtObj.mjOBJ_BODY,objectbody,release_twist,0)
                release_position_deviation=float(np.linalg.norm(data.xpos[objectbody]-initial_object_pos))
                release_orientation_deviation=orientation_deviation()
                fixture_max_position_deviation=max(fixture_max_position_deviation,release_position_deviation)
                fixture_max_orientation_deviation=max(fixture_max_orientation_deviation,release_orientation_deviation)
            data.eq_active[fixture]=False
        data.qfrc_applied[:]=0;data.xfrc_applied[:]=0
        mujoco.mj_step1(model,data)
        cable,diag=tendon_cable_forces(model,data,tids,sd,sq,Lfree,params.cable_stiffness_N_m,params.cable_damping_Ns_m)
        data.qfrc_applied[:]=cable
        max_object_direct_qfrc=np.maximum(max_object_direct_qfrc,np.abs(data.qfrc_applied[object_dofs]))
        phase=smooth(t,params.lift_start_s,params.lift_end_s)
        qtarget=target_final*phase
        vtarget=target_final*smooth_rate(t,params.lift_start_s,params.lift_end_s)
        arm_error=qtarget-data.qpos[aq]
        required=params.arm_kp*arm_error+params.arm_kd*(vtarget-data.qvel[ad])
        if params.gravity_compensation:required+=data.qfrc_bias[ad]
        arm_tau=np.clip(required,-params.arm_cap_Nm,params.arm_cap_Nm)
        wind=params.wind_angle_rad*smooth(t,params.close_start_s,params.close_end_s)
        windspeed=params.wind_angle_rad*smooth_rate(t,params.close_start_s,params.close_end_s)
        micro_required=params.spool_kp*(wind-data.qpos[sq])+params.spool_kd*(windspeed-data.qvel[sd])
        micro_tau=np.clip(micro_required,-params.micro_cap_Nm,params.micro_cap_Nm)
        data.ctrl[motorids]=np.r_[arm_tau,micro_tau]
        if params.disturb_N and 6.<=t<6.2:data.xfrc_applied[objectbody,1]=params.disturb_N
        peak_tension=np.maximum(peak_tension,diag['tension_N'])
        max_omega_spool=np.maximum(max_omega_spool,np.abs(data.qvel[sd]))
        max_energy_residual=max(max_energy_residual,abs(diag['energy_balance_residual_W']))
        if t>=params.release_s:
            peak_error=np.maximum(peak_error,np.abs(arm_error))
            post_peak_tension=np.maximum(post_peak_tension,diag['tension_N'])
            post_max_omega_spool=np.maximum(post_max_omega_spool,np.abs(data.qvel[sd]))
            post_max_energy_residual=max(post_max_energy_residual,abs(diag['energy_balance_residual_W']))
            if data.eq_active[fixture]:released_eq_reenabled=True
        rel,objcontacts,selfcontacts,normal_indices=observe_geometry(t)
        if t+1e-9>=params.lift_end_s and ref_local is not None:
            sat_arm+=(np.abs(required)>params.arm_cap_Nm*.999)
            sat_micro+=(np.abs(micro_required)>params.micro_cap_Nm*.999)
        if step%sample_stride==0:
            physical_records.append([t,*data.xpos[objectbody],*(rel if ref_local is None else rel-ref_local),*np.degrees(data.qpos[aq]),*np.degrees(data.qpos[fq]),*diag['tension_N'],*arm_tau,*micro_tau,0.,len(objcontacts),len(selfcontacts),int(data.eq_active[fixture]),0.])
        if record and step%record_stride==0:
            traces.append((t,data.qpos.copy()))
        if launch and step%max(1,round(.02/params.dt))==0:
            if not launch.is_running():break
            launch.sync();time.sleep(max(0,startwall+data.time-time.monotonic()))
        mujoco.mj_step2(model,data)
        completed_steps+=1
        if ref_local is not None:
            completed_hold_duration+=max(0.,min(float(data.time),params.end_s)-max(t,params.lift_end_s,release_time))
        observe_joint_limits()
        # Log actual solved motor forces, including the XML actuator clamps.
        actual_motor=np.abs(data.actuator_force[motorids])
        peak_arm=np.maximum(peak_arm,actual_motor[:4]);peak_micro=np.maximum(peak_micro,actual_motor[4:])
        if ref_local is not None:
            post_peak_arm=np.maximum(post_peak_arm,actual_motor[:4]);post_peak_micro=np.maximum(post_peak_micro,actual_motor[4:])
        # step2 solves efc_force for the SAME contact array made by step1.
        # Taking forces before step2 would incorrectly reuse the previous solve.
        if step%sample_stride==0:
            nsum=0.;world_force=np.zeros(3)
            for idx in normal_indices:
                con=data.contact[idx];f=np.zeros(6)
                mujoco.mj_contactForce(model,data,idx,f)
                nsum+=f[0]
                sign=1 if con.geom2==objectid else -1
                world_force+=sign*con.frame.reshape(3,3).T@f[:3]
            physical_records[-1][27]=nsum
            physical_records[-1][-1]=float(world_force[2])
            if t>=params.lift_end_s and ref_local is not None:hold_vertical_contact.append(float(world_force[2]))
        if not np.all(np.isfinite(data.qpos)) or not np.all(np.isfinite(data.qvel)) or np.max(np.abs(data.qvel))>10000 or data.time<t:
            invalid=True;invalid_reason='nonfinite/excessive velocity or automatic reset';break
    # No state forcing: a final forward evaluation checks the last integrated
    # endpoint, which otherwise would be missing from pre-step observations.
    if not invalid:
        mujoco.mj_forward(model,data)
        observe_geometry(float(data.time),count_hold=False)
        observe_joint_limits()
    if launch:launch.close()
    warnings={str(i):int(w.number) for i,w in enumerate(data.warning) if w.number}
    if warnings:invalid=True;invalid_reason+=' MuJoCo warning'
    hold_z=np.array(hold_z);hold_rel=np.array(hold_rel)
    lift_min=float(np.min(hold_z)-release_object_z) if len(hold_z) and release_object_z is not None else -math.inf
    hold_slip=float(np.max(np.linalg.norm(hold_rel-hold_rel[0],axis=1))) if len(hold_rel) else math.inf
    contact_fraction=held_contact_samples/max(hold_samples,1)
    limit_peak=np.maximum(limit_lower_peak,limit_upper_peak)
    maximum_joint_limit_overshoot_deg=float(np.degrees(np.max(limit_peak))) if len(limit_peak) else 0.
    limit_details={mujoco.mj_id2name(model,mujoco.mjtObj.mjOBJ_JOINT,int(j)):
        {'below_lower_deg':float(np.degrees(limit_lower_peak[i])),
         'above_upper_deg':float(np.degrees(limit_upper_peak[i])),
         'maximum_deg':float(np.degrees(limit_peak[i]))} for i,j in enumerate(limited_joints)}
    criteria={'finite_without_engine_warnings':not invalid,'fixture_permanently_released':ref_local is not None and not released_eq_reenabled and not data.eq_active[fixture],
              'initial_placement_clear':initial_object_penetration<=.0001,
              'minimum_hold_lift_at_least_50mm':lift_min>=.05,'slip_from_release_at_most_5mm':max_slip<=.005,'hold_slip_at_most_5mm':hold_slip<=.005,
              'no_external_support_contact':len(bad_contacts)==0,'continuous_gripper_contact':contact_fraction>=.99,
              'two_moving_fingers_contact':two_finger_samples/max(hold_samples,1)>=.95,
              'pad_contact_through_hold':pad_contact_samples/max(hold_samples,1)>=.95,
              'penetration_at_most_0p8mm':max_penetration<=.0008,'robot_penetration_at_most_1mm':max_self_penetration<=.001,
              'full_cycle_object_penetration_at_most_0p8mm':max_all_object_penetration<=.0008,
              'all_joint_limit_overshoot_at_most_0p5deg':maximum_joint_limit_overshoot_deg<=.5,
              'no_direct_generalized_force_on_payload':bool(np.max(max_object_direct_qfrc)<=1e-12),
              'arm_tracking_error_at_most_3deg':bool(np.max(peak_error)<=np.radians(3)),
              'full_three_second_hold':bool(params.end_s-params.lift_end_s>=3.-1e-9 and completed_hold_duration>=3.-1e-9)}
    success=all(criteria.values())
    result={'name':params.name,'status':'PASS_CONDITIONAL' if success else ('INVALID_NUMERICS' if invalid else 'FAIL'),
            'model_file':model_path.name,'model_sha256':hashlib.sha256(model_path.read_bytes()).hexdigest(),'mujoco_version':mujoco.__version__,
            'collision_geometry_variant':modelmeta.get('collision_geometry_variant','full'),
            'parameters':asdict(params),'object':{k:modelmeta[k] for k in ['shape','mass_kg','diameter_m','height_m','orientation','object_palm_z_m','print_mass_scale']},
            'criteria':criteria,'minimum_hold_lift_mm':lift_min*1000,'max_slip_from_release_mm':max_slip*1000,'max_hold_slip_mm':hold_slip*1000,
            'max_object_penetration_mm':max_penetration*1000,'max_robot_penetration_mm':max_self_penetration*1000,
            'max_object_penetration_postrelease_mm':max_penetration*1000,'max_object_penetration_full_cycle_mm':max_all_object_penetration*1000,
            'initial_object_penetration_mm':initial_object_penetration*1000,'initial_placement_tolerance_mm':.1,
            'initial_placement_contacts':initial_placement_contacts,
            'max_arm_tracking_error_deg':np.degrees(peak_error).tolist(),'peak_arm_torque_Nm':peak_arm.tolist(),'peak_micro_torque_Nm':peak_micro.tolist(),
            'peak_cable_tension_N':peak_tension.tolist(),'hold_arm_saturation_fraction':(sat_arm/max(1,hold_samples)).tolist(),
            'hold_micro_saturation_fraction':(sat_micro/max(1,hold_samples)).tolist(),'max_spool_speed_rad_s':max_omega_spool.tolist(),
            'peak_load_scope':'Entire integrated cycle, including fixture-assisted closing; torque fields use actual actuator_force.',
            'postrelease_peak_arm_torque_Nm':post_peak_arm.tolist(),'postrelease_peak_micro_torque_Nm':post_peak_micro.tolist(),
            'postrelease_peak_cable_tension_N':post_peak_tension.tolist(),'postrelease_max_spool_speed_rad_s':post_max_omega_spool.tolist(),
            'hold_finger_contact_fraction':(finger_contact_counts/max(1,hold_samples)).tolist(),'hold_gripper_contact_fraction':contact_fraction,
            'hold_two_finger_contact_fraction':two_finger_samples/max(hold_samples,1),'hold_pad_contact_fraction':pad_contact_samples/max(hold_samples,1),
            'mean_hold_object_contact_vertical_N':float(np.mean(hold_vertical_contact)) if hold_vertical_contact else None,
            'external_support_contact_geoms':sorted(str(x) for x in bad_contacts),'palm_cradle_contact':postrelease_palm_contact,
            'max_cable_energy_balance_residual_W':max_energy_residual,'warnings':warnings,'invalid_reason':invalid_reason,
            'postrelease_max_cable_energy_balance_residual_W':post_max_energy_residual,
            'maximum_joint_limit_overshoot_deg':maximum_joint_limit_overshoot_deg,'joint_limit_overshoot_deg':limit_details,
            'joint_limit_tolerance_deg':.5,'max_payload_free_dof_qfrc_applied_abs':max_object_direct_qfrc.tolist(),
            'payload_free_dof_qfrc_units':['N','N','N','Nm','Nm','Nm'],
            'fixture_max_position_deviation_mm':fixture_max_position_deviation*1000,
            'fixture_max_orientation_deviation_deg':float(np.degrees(fixture_max_orientation_deviation)),
            'release_time_s':release_time,
            'release_position_deviation_mm':None if release_position_deviation is None else release_position_deviation*1000,
            'release_orientation_deviation_deg':None if release_orientation_deviation is None else float(np.degrees(release_orientation_deviation)),
            'release_linear_velocity_world_m_s':None if release_twist is None else release_twist[3:].tolist(),
            'release_angular_velocity_world_rad_s':None if release_twist is None else release_twist[:3].tolist(),
            'completed_hold_duration_s':completed_hold_duration,'completed_integration_steps':completed_steps,
            'geometry_observation_count':geometry_observations,'hold_step_observations':hold_samples,
            'criteria_observation_cadence_s':params.dt,'telemetry_cadence_s':sample_stride*params.dt,
            'simulation_seconds':float(data.time),'wall_seconds':time.monotonic()-startwall,
            'scope':'Unmeasured-parameter conditional experiment. Initial fixture only aids prepositioning; all pose motion after initialization comes from mj_step integration. Slips, support contacts, penetration and joint-limit overshoot checked every integration step plus final endpoint. Ideal frictionless cable guides; finger frictionloss is an explicit unmeasured joint-friction scenario. No thermal/structural validation.'}
    return result,{'time':np.array([r[0] for r in traces]),'qpos':np.array([r[1] for r in traces]),'telemetry':np.array(physical_records),'final_qpos':data.qpos.copy()}

def save_result(result,trace,directory):
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=True)
    stem=result['name']
    (directory/(stem+'.json')).write_text(json.dumps(result,indent=2),encoding='utf-8')
    if len(trace['qpos']):np.savez_compressed(directory/(stem+'_trajectory.npz'),**trace)
    header='time_s,obj_x_m,obj_y_m,obj_z_m,slip_x_m,slip_y_m,slip_z_m,yaw_deg,shoulder_deg,elbow_deg,wrist_deg,f1prox_deg,f1dist_deg,f2prox_deg,f2dist_deg,f3prox_deg,f3dist_deg,T1_N,T2_N,T3_N,arm1_Nm,arm2_Nm,arm3_Nm,arm4_Nm,spool1_Nm,spool2_Nm,spool3_Nm,contact_normal_sum_N,object_contacts,robot_contacts,fixture_active,object_contact_vertical_N'
    np.savetxt(directory/(stem+'_telemetry.csv'),trace['telemetry'],delimiter=',',header=header,comments='')

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--model',required=True,type=Path);ap.add_argument('--parameters',type=Path);ap.add_argument('--name');ap.add_argument('--view',action='store_true');ap.add_argument('--record',action='store_true');ap.add_argument('--output',type=Path,default=OUT/'results')
    a=ap.parse_args();p=Parameters(**json.loads(a.parameters.read_text(encoding='utf-8'))) if a.parameters else Parameters()
    if a.name:p.name=a.name
    r,tr=run_case(a.model,p,record=a.record,viewer=a.view);save_result(r,tr,a.output)
    print(json.dumps(r,indent=2))
