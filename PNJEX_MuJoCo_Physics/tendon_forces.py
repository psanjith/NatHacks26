"""Energy-consistent unilateral cables coupling 3 winches to passive fingers.

No qpos, XML, contacts, actuator controls or springs are changed by this module.
Call after mj_step1 (fresh tendon lengths/Jacobians/velocities), add the returned
qfrc vector to qfrc_applied, then call mj_step2. Reset the caller's applied forces
each step rather than accumulating the returned vector across steps.
All arguments use SI units. Positive spool rotation winds cable onto the drum.
"""
import numpy as np


def dense_tendon_jacobian(model, data):
    """Return d(length)/d(qvel-coordinate), including MuJoCo 4 sparse storage.

    In MuJoCo 4 ten_J is sparse even when mj_isSparse(model)==0; its structure
    moved to mjModel. Earlier versions may use mjData or a dense 2-D array.
    """
    values=np.asarray(data.ten_J)
    if values.ndim==2 and values.shape==(model.ntendon,model.nv):
        return values.copy()
    owner=model if hasattr(model,'ten_J_rowadr') else data
    if all(hasattr(owner,k) for k in ['ten_J_rowadr','ten_J_rownnz','ten_J_colind']):
        out=np.zeros((model.ntendon,model.nv))
        for row in range(model.ntendon):
            start=int(owner.ten_J_rowadr[row]);count=int(owner.ten_J_rownnz[row])
            cols=np.asarray(owner.ten_J_colind[start:start+count],dtype=int)
            out[row,cols]=values.ravel()[start:start+count]
        return out
    if values.size==model.ntendon*model.nv:
        return values.reshape(model.ntendon,model.nv).copy()
    raise ValueError('Unrecognized tendon Jacobian layout')


def unilateral_response(extension_m, extension_rate_m_s, stiffness_N_m, damping_Ns_m=0):
    """Tension, stored elastic energy and nonnegative dissipated power.

    Compression and geometrically slack configurations exert no cable force.
    Damping is active only when stretched; force clipping prevents pushing.
    No arbitrary tension multiplier or cable force cap is applied. Limit servo
    torque instead so a loaded spool can stall or pay out with equal reaction.
    """
    e,edot,k,c=np.broadcast_arrays(np.asarray(extension_m,dtype=float),
        np.asarray(extension_rate_m_s,dtype=float),np.asarray(stiffness_N_m,dtype=float),
        np.asarray(damping_Ns_m,dtype=float))
    if np.any(k<=0) or np.any(c<0):
        raise ValueError('Cable stiffness must be positive and damping nonnegative')
    ep=np.maximum(e,0)
    elastic=k*ep
    tension=np.where(e>0,np.maximum(0,elastic+c*edot),0)
    energy=.5*k*ep**2
    dissipation=np.where(e>0,(tension-elastic)*edot,0)
    return tension,energy,dissipation


def tendon_cable_forces(model, data, tendon_ids, spool_dof_ids, spool_qpos_ids,
                        free_lengths_m, stiffness_N_m, damping_Ns_m=0,
                        spool_radius_m=.008, spool_q0_rad=0):
    """Return (qfrc, diagnostic) for coupled spatial cables and physical spools.

    e_i = L_spatial_i(q) + r_i*(theta_i-theta0_i) - L_free_i
    Fq = -sum(T_i*dL_i/dq), Ftheta_i additionally += -r_i*T_i
    U_i = 1/2*k_i*max(e_i,0)^2.

    L_free_i = L_spatial_i(home)+slack_i if all spool home angles are theta0.
    The spatial path must start at a palm-fixed outlet: do not also attach that
    site to the winding rotor or the winding motion would be counted twice.
    qfrc includes reaction torque at each spool, not just finger closing torque.
    """
    tids=np.asarray(tendon_ids,dtype=int)
    dads=np.asarray(spool_dof_ids,dtype=int)
    qads=np.asarray(spool_qpos_ids,dtype=int)
    if tids.shape!=dads.shape or tids.shape!=qads.shape:
        raise ValueError('One spool dof and qpos coordinate are required per tendon')
    radius=np.broadcast_to(np.asarray(spool_radius_m,dtype=float),tids.shape)
    if np.any(radius<=0):
        raise ValueError('Positive radius uses positive theta as winding direction')
    J=dense_tendon_jacobian(model,data)[tids]
    if np.any(np.abs(J[:,dads])>1e-9):
        raise ValueError('Spatial path already depends on spool rotation; move outlet to palm or remove the extra winding term')
    length=np.asarray(data.ten_length)[tids]
    speed=J@np.asarray(data.qvel)
    winding=np.asarray(data.qpos)[qads]-np.asarray(spool_q0_rad)
    omega=np.asarray(data.qvel)[dads]
    e=length+radius*winding-np.asarray(free_lengths_m)
    edot=speed+radius*omega
    tension,energy,dissipation=unilateral_response(e,edot,stiffness_N_m,damping_Ns_m)
    force=-(J.T@tension)
    np.add.at(force,dads,-radius*tension)
    mechanical_power=float(force@np.asarray(data.qvel))
    elastic_rate=float(np.sum(np.asarray(stiffness_N_m)*np.maximum(e,0)*edot))
    diagnostic=dict(tension_N=tension,extension_m=e,extension_rate_m_s=edot,
        spatial_length_m=length,spatial_speed_m_s=speed,
        spool_reaction_torque_Nm=-radius*tension,
        elastic_energy_J=energy,dissipated_power_W=dissipation,
        generalized_cable_power_W=mechanical_power,
        energy_balance_residual_W=mechanical_power+elastic_rate+float(np.sum(dissipation)))
    return force,diagnostic


def local_cable_stiffness(model,data,tendon_ids,spool_dof_ids,stiffness_N_m,spool_radius_m=.008):
    """Return K=sum(k*a*a.T) at the current geometry, assuming taut cables.

    With a dense generalized mass matrix M, the largest eigenvalue of
    inv(M)@K estimates squared elastic frequency. This assists timestep
    convergence testing; it is not a replacement for simulation convergence.
    """
    ids=np.asarray(tendon_ids,dtype=int);dads=np.asarray(spool_dof_ids,dtype=int)
    A=dense_tendon_jacobian(model,data)[ids]
    radius=np.broadcast_to(np.asarray(spool_radius_m),ids.shape)
    A[np.arange(len(ids)),dads]+=radius
    k=np.broadcast_to(np.asarray(stiffness_N_m),ids.shape)
    return A.T@(k[:,None]*A)
